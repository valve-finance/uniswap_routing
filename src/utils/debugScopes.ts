// See this site for usage and logger configuration:
//   - https://github.com/pimterry/loglevel
//
import log from 'loglevel'

// The prefix library calls setLevel with no option regarding persistence to
// local storage.
import prefix from 'loglevel-plugin-prefix'
import chalk from 'chalk'

const DEFAULT_LOG_LEVEL="DEBUG"


type LogLevelColorMapType = {
  [index: string]: chalk.Chalk
}
const colors: LogLevelColorMapType = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
}


function configureLogPrefix(aLog: log.Logger) {
  prefix.apply(
    aLog,
    {
      template: '[%t] %l (%n):',
      levelFormatter(level) {
        const ucLevel = level.toUpperCase()
        return `${colors[ucLevel](ucLevel)}`
      },
      nameFormatter(name) {
        const moduleName = (name) ? name : 'global'
        return `${chalk.gray(`${moduleName}`)}`
      },
      timestampFormatter(date) {
        return `${chalk.gray(`${date.toISOString()}`)}`
      }
    }
  )
  aLog.setLevel(DEFAULT_LOG_LEVEL)
}

prefix.reg(log)
configureLogPrefix(log)

/**
 *  getLog:
 *
 *    Returns a logger configured with our prefixes etc.
 *
 *  TODO:
 *    - Do we need to track calls to this to prevent duplicate reg/apply calls?
 *
 */
export function getLog(logName: string="") {
   let theLog: log.Logger = log
   if (logName) {
     theLog = log.getLogger(logName)
     configureLogPrefix(theLog)
   }

   return theLog
}

function levelNumToString(aLevelNum: number) {
  switch (aLevelNum) {
    case log.levels.TRACE:
      return 'TRACE'
    case log.levels.DEBUG:
      return 'DEBUG'
    case log.levels.INFO:
      return 'INFO'
    case log.levels.WARN:
      return 'WARN'
    case log.levels.ERROR:
      return 'ERROR'
    default:
  }

  return ''
}

function padToSpaces(aString: string, numSpaces: number=25): string {
  const length = (aString) ? aString.length : 0
  const spacesNeeded = (numSpaces >= length) ? numSpaces - length : 0
  return `${aString}${' '.repeat(spacesNeeded)}`
}

export function getLogSettingsStr(): string {
  let logSettingsStr = '\n'
  logSettingsStr += 'Log Settings\n'
  logSettingsStr += '****************************************\n'
  logSettingsStr += `${padToSpaces('default:')}${levelNumToString(log.getLevel())}\n`

  try {
    const logDict = log.getLoggers()
    for (const logName in logDict) {
      const leftCol = padToSpaces(`${logName}:`)
      logSettingsStr += `${leftCol}${levelNumToString(log.getLogger(logName).getLevel())}\n`
    }
  } catch (suppressedError) {
    logSettingsStr += `Error getting log settings:\n${suppressedError}`
  }

  logSettingsStr += '\n'

  return logSettingsStr
}
