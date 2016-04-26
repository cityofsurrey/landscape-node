/**
 * @file Shell script for executing Landscape scripts and retrieving the results.
 * @author Alazhar Shamshuddin
 */
import bunyan from 'bunyan'
import childProcess from 'child_process'
import program from 'commander'
import nodePrint from 'node-print'
const execSync = childProcess.execSync

// -----------------------------------------------------------------------------
// Global Variables
// -----------------------------------------------------------------------------

/**
 * The Bunyan logger.
 */
const gLog = bunyan.createLogger({ name: 'deploy.js' })

/*
 * The Docker container through which we execute all our Landscape API calls
 * for the DEV and PLY servers.
 */
const gLandscapeCmdPrefixDev =
  `docker run --rm -e LANDSCAPE_API_URI=${process.env.LANDSCAPE_API_DEV_URI} ` +
  `-e LANDSCAPE_API_KEY=${process.env.LANDSCAPE_API_DEV_KEY} ` +
  `-e LANDSCAPE_API_SECRET=${process.env.LANDSCAPE_API_DEV_SECRET} ` +
  `-e LANDSCAPE_API_SSL_CA_FILE=${process.env.LANDSCAPE_API_DEV_SSL_CA_FILE} ` +
  `-v ${process.env.LANDSCAPE_API_DEV_VOLUMES} cityofsurrey/landscape-api `

/*
 * The Docker container through which we execute all our Landscape API calls
 * for the TST and PRD servers.
 */
const gLandscapeCmdPrefixTst =
  'docker run --rm ' +
  '-e LANDSCAPE_API_URI -e LANDSCAPE_API_KEY -e LANDSCAPE_API_SECRET ' +
  'cityofsurrey/landscape-api'

/*
 * The actual Docker container through which we execute all our Landscape API
 * calls.
 */
let gLandscapeCmdPrefix = null

/*
 * The key used to identify the summary record generated by this script.
 */
const gSummaryRecord = '** ALL (Summary) **'

/*
 * The ID of the Landscape script we will execute. This value may be passed
 * in via the command-line.
 */
let gLandscapeScript = null

/*
 * The activity group (i.e., the set of servers) on which to execute the
 * Landscape script.  This value may be passed in via the command-line.
 */
let gLandscapeActivityGroup = null

/*
 * An associative array, keyed on computer id, containing information about
 * each server in the activity group with which this script was run.
 */
let gServers = null

// -----------------------------------------------------------------------------
// Functions
// -----------------------------------------------------------------------------

/**
 * Generates an activity report for the parent activity that includes
 * the status of the child activities as well.
 *
 * @param {string} parentActivityId - The Landscape activity (command) on
 *   we want to report on.
 *
 * @returns {object}  An associative array, keyed on computer id, containing
 *   information about each server in the specified activity group.
 */
function generateDetailedActivityReport(parentActivityId) {
  const report = []

    // Get all the child activities and their statuses.
  let childActivities =
    execSync(`${gLandscapeCmdPrefix} get-activities ` +
             `--query parent-id:${parentActivityId} --json`)
  childActivities = JSON.parse(childActivities)

  // Summarize each child activity and add the summary to the reports array.
  childActivities.forEach(childActivity => {
    const record = {
      computer_name: gServers[childActivity.computer_id].hostname,
      computer_id: childActivity.computer_id,
      activity_id: childActivity.id,
      activity_status: childActivity.activity_status,
    }
    report.push(record)
  })

  // Sort the report by computer name.
  report.sort(
    (a, b) => (a.computer_name.toLowerCase() > b.computer_name.toLowerCase()) -
              (a.computer_name.toLowerCase() < b.computer_name.toLowerCase())
  )

  // Get the parent activity -- we assume there is only one.
  let parentActivity =
    execSync(`${gLandscapeCmdPrefix} get-activities --query id:${parentActivityId} --json`)
  parentActivity = JSON.parse(parentActivity)[0]

  // Summarize the parent activity and add the summary to the end of the
  // reports array.
  report.push({
    computer_name: gSummaryRecord,
    computer_id: '-',
    activity_id: parentActivity.id,
    activity_status: parentActivity.activity_status,
  })

  return report
}

/**
 * Gets the set of servers that are a part of the specified activity group in
 * Landscape.
 *
 * @param {string} activityGroup - A group of servers defined in Landscape.
 *
 * @returns {object}  An associative array, keyed on computer id, containing
 *   information about each server in the specified activity group.
 */
function getServers(activityGroup) {
  let tmpServers =
    execSync(`${gLandscapeCmdPrefix} get-computers ` +
             `--query tag:${activityGroup} --json`)
  tmpServers = JSON.parse(tmpServers)

  const servers = {}
  tmpServers.forEach(server => {servers[server.id] = server})

  return servers
}

/**
 * Compares two JSON objects for equality.  This function cheats by comparing
 * the string representation of each JSON object for equality.
 *
 * @param {object} json1 - A JSON object.
 * @param {object} json2 - Another JSON object to compare the first against.
 *
 * @returns {object}  An associative array, keyed on computer id, containing
 *                    information about each server in the specified activity
 *                    group.
 */
function isEqual(report1, report2) {
  const report1String = JSON.stringify(report1)
  const report2String = JSON.stringify(report2)

  return (report1String === report2String)
}

/**
 * Processes the command line arguments with which this script was called.
 */
function processCommandLineArgs() {
  program
    .version('0.0.1')
    .usage('deploy.js --script <id> --tag <name> [--dev]')
    .description('Executes the specified script in Landscape, on a specified ' +
                 'group of servers.')
    .option('-d, --dev',
            'use the DEV/PLY instance of Landscape (optiona)')
    .option('-s, --script <id>',
            'the ID of the Landscape script to execute (required)',
            parseInt)
    .option('-t, --tag <name>',
            'the group of servers on which to execute the script (required)')

  program.on('--help', () => {
    console.log('  Examples:')
    console.log('')
    console.log('    $ deploy.js --script 28 --tag ply-servers --dev')
    console.log('    $ deploy.js --help')
    console.log('')
  })

  program.parse(process.argv)

  if (!program.script || !program.tag) {
    program.help()
  }

  gLandscapeActivityGroup = program.tag
  gLandscapeScript = program.script

  if (!program.dev) {
    gLandscapeCmdPrefix = gLandscapeCmdPrefixTst
    gLog.info(`Running '${__filename} --tag ${gLandscapeActivityGroup} ` +
              `--script ${gLandscapeScript}' on Landscape TST`)
  }
  else {
    gLandscapeCmdPrefix = gLandscapeCmdPrefixDev
    gLog.info(`Running '${__filename} --tag ${gLandscapeActivityGroup} ` +
              `--script ${gLandscapeScript}' on Landscape DEV`)
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

/**
 * The main driver of this script.
 */
function main() {
  processCommandLineArgs()

  gLog.info('Getting servers associated with the Landscape activity group ' +
            `'${gLandscapeActivityGroup}'.`)

  gServers = getServers(gLandscapeActivityGroup)

  // Execute the Landscape script and capture the parent process or activity.
  gLog.info(`Executing Landscpate script '${gLandscapeScript}' for ` +
           `'${gLandscapeActivityGroup}'.`)

  let parentActivity =
    execSync(`${gLandscapeCmdPrefix} execute-script ` +
             `tag:${gLandscapeActivityGroup} ${gLandscapeScript} --json`)

  parentActivity = JSON.parse(parentActivity)

  // Repeatedly query Landscape on the status of the parent activity and
  // all its child activities (i.e., the actual running of the specified
  // script on the set of servers in the activity group.)  Print the status
  // of parent and child activities to console every time it changes.  Do this
  // until the parent activity's status indicates it's finished.  (We are
  // are assuming the parent's activity status won't be set to a finished
  // state if all it's child activities have not completed.)
  let oldActivityReport = null
  let newActivityReport = null
  let summaryReportIndex = null

  do {
    execSync('sleep 15')

    newActivityReport = generateDetailedActivityReport(parentActivity.id)

    if (!isEqual(oldActivityReport, newActivityReport)) {
      gLog.info("The deployment's current status is:")
      nodePrint.pt(newActivityReport)
    }

    oldActivityReport = newActivityReport
    summaryReportIndex = newActivityReport.length - 1
    gLog.info('Deploying the software...')
  }
  while (newActivityReport[summaryReportIndex].activity_status !== 'canceled' &&
         newActivityReport[summaryReportIndex].activity_status !== 'failed' &&
         newActivityReport[summaryReportIndex].activity_status !== 'succeeded')

  // Log the appropriate info or error message based on how the parent activity
  // finished.
  if (newActivityReport[summaryReportIndex].activity_status === 'succeeded' ||
      newActivityReport[summaryReportIndex].activity_status === 'canceled') {
    gLog.info('Deployment completed with status ' +
              `'${newActivityReport[summaryReportIndex].activity_status}'.`)
  }
  else {
    gLog.error('Deployment completed with status ' +
               `'${newActivityReport[summaryReportIndex].activity_status}'.`)
  }
}

main()
