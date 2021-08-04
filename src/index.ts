import 'dotenv/config.js'
import { Command, parse } from 'commander'
import { shell } from './commands/shell'
import { startSocketServer } from './commands/socketServer'

const program = new Command();

program
  .command('shell')
  .description('Starts a basic shell for exploring Uniswap optimizing router results.')
  .action(shell)

const DEFAULT_SOCKET_SVR_PORT = '3031'
program
  .command('socketServer [port]')
  .description('Starts a socket server that accepts route requests. Default port is ' +
               `${DEFAULT_SOCKET_SVR_PORT} that can be overriden with the optional port argment.`)
  .action(async (port) => {
    port = port || DEFAULT_SOCKET_SVR_PORT
    await startSocketServer(port)
  })

program
  .command('help', { isDefault: true })
  .action(() => {
    program.help()
  })

program.parse(process.argv)