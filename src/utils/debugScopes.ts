// See this site for usage and logger configuration: https://github.com/pimterry/loglevel
//
import log from 'loglevel'

// The prefix library calls setLevel with no option regarding persistence to local storage.
//
import prefix from 'loglevel-plugin-prefix'
import chalk from 'chalk'


type LogLevelColorMapType = {
  [index: string]: chalk.Chalk
}


const DEFAULT_LOG_LEVEL="DEBUG"

const COLORS: LogLevelColorMapType = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
}


function _configureLogPrefix(theLog: log.Logger) {
  prefix.apply(
    theLog,
    {
      template: '[%t] %l (%n):',
      levelFormatter(level) {
        const levelUC = level.toUpperCase()
        return `${COLORS[levelUC](levelUC)}`
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

  theLog.setLevel(DEFAULT_LOG_LEVEL)
}

/**
 *  getLog:
 *
 *    Returns a logger configured with our prefixes if logName is specified. The default
 *    log configuration otherwise.
 *
 */
export function getLog(logName: string="") {
   if (logName) {
    const theLog = log.getLogger(logName)
     _configureLogPrefix(theLog)
     return theLog
   }

   return log 
}


prefix.reg(log)
_configureLogPrefix(log)