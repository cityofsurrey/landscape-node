/**
 * @file Shell script for executing Landscape scripts and retrieving the results.
 * @author Alazhar Shamshuddin
 */
import bunyan from 'bunyan'
import { execSync } from 'child_process'
import program from 'commander'
import Landscape from './landscape'
import nodePrint from 'node-print'

// -----------------------------------------------------------------------------
// Global Variables
// -----------------------------------------------------------------------------

/**
 * The Bunyan logger.
 */
const gLog = bunyan.createLogger({ name: 'landscape-deploy' })

/**
 * The Landscape wrapper class through which we execute all our Landscape API
 * calls.
 */
let gLandscapeCmd = null

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

/*
 * The key used to identify the summary record generated by this script.
 */
const gSummaryRecord = '** ALL (Summary) **'

// -----------------------------------------------------------------------------
// Functions
// -----------------------------------------------------------------------------

/**
 * Converts the detailed activity report to a multi-line string as per the
 * example below:
 *
 *   computerName1: status
 *   ...
 *   computerNameN: status
 *
 * @param {object} activityReport - A detailed activity report produced by the
 *   generateDetailedActivityReport function.
 *
 * @returns {string} A summarized activity report as shown above.
 */
function convertDetailedActivityReportToText(activityReport) {
  let report = ''

  for (let i = 0; i < activityReport.length; ++i) {
    const record = activityReport[i]
    report += `${record.computer_name}: ${record.activity_status}\n`
  }

  return report
}

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
  const childActivities = gLandscapeCmd.getChildActivities(parentActivityId)

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
  let parentActivity = gLandscapeCmd.getActivities(parentActivityId)
  parentActivity = parentActivity[0]

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
export function getServers(activityGroup) {
  const tmpServers = gLandscapeCmd.getComputers(activityGroup)

  const servers = {}
  tmpServers.forEach(server => {servers[server.id] = server})

  return servers
}

/**
 * Compares two JSON objects for equality.  This function cheats by comparing
 * the string representation of each JSON object for equality.
 *
 * @param {object} report1 - A JSON object.
 * @param {object} report2 - Another JSON object to compare the first against.
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
 * Posts a notification to Slack.
 *
 * @param {string} text - The message to post to Slack.
 * @param {string} username - The name of the message sender.
 * @param {string} channel - The channel or user who will receive the message.
 * @param {string} iconEmoji -  The sender's emoji or user icon.
 */
function postSlackNotification(text,
                               username = 'Deployment Guru Bot',
                               channel = '#bot-deployments',
                               iconEmoji = ':octopus:') {
  const url = 'https://hooks.slack.com/services/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'

  let payload = {
    username: `${username}`,
    channel: `${channel}`,
    icon_emoji: `${iconEmoji}`,
    text: `${text}`,
  }
  payload = JSON.stringify(payload)

  const cmd = `curl -s -X POST --data-urlencode 'payload=${payload}' ${url}`
  execSync(cmd)
}

/**
 * Processes the command line arguments with which this script was called.
 */
function processCommandLineArgs() {
  program
    .version('0.0.1')
    .usage('--script <id> --tag <name> [--dev]')
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
    console.log('    $ landscape-deploy --script 28 --tag ply-servers --dev')
    console.log('    $ landscape-deploy --help')
    console.log('')
  })

  program.parse(process.argv)

  if (!program.script || !program.tag) {
    program.help()
  }

  gLandscapeActivityGroup = program.tag
  gLandscapeScript = program.script

  if (!program.dev) {
    gLandscapeCmd = new Landscape(process.env.LANDSCAPE_API_URI,
                                  process.env.LANDSCAPE_API_KEY,
                                  process.env.LANDSCAPE_API_SECRET)

    gLog.info(`Running '${__filename} --tag ${gLandscapeActivityGroup} ` +
              `--script ${gLandscapeScript}' on Landscape TST`)
  }
  else {
    gLandscapeCmd = new Landscape(
      process.env.LANDSCAPE_API_DEV_URI,
      process.env.LANDSCAPE_API_DEV_KEY,
      process.env.LANDSCAPE_API_DEV_SECRET,
      `${process.env.LANDSCAPE_API_DEV_CERT_FOLDER}/` +
      `${process.env.LANDSCAPE_API_DEV_CERT_FILE}`)

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
  gLog.info(
    `Executing Landscpate script '${gLandscapeScript}' for ` +
    `'${gLandscapeActivityGroup}'.`)

  postSlackNotification(
    `I am deploying software using Landscape script '${gLandscapeScript}' ` +
    `for the group of servers called '${gLandscapeActivityGroup}'...`)

  const parentActivity =
    gLandscapeCmd.executeScript(gLandscapeActivityGroup, gLandscapeScript)

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
  const message = 'Deployment completed with status ' +
                  `'${newActivityReport[summaryReportIndex].activity_status}'.`

  postSlackNotification(
    'I have finished deploying software using Landscape script ' +
    `'${gLandscapeScript}' for the group of servers called ` +
    `'${gLandscapeActivityGroup}'.  Here are the details for each server:`)
  postSlackNotification(convertDetailedActivityReportToText(newActivityReport))

  if (newActivityReport[summaryReportIndex].activity_status === 'succeeded' ||
      newActivityReport[summaryReportIndex].activity_status === 'canceled') {
    gLog.info(message)
  }
  else {
    gLog.error(message)
  }
}

main()
