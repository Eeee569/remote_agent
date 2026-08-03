import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'

/** M0 stub — replaced by the full handler registry. */
export function registerIpc(): void {
  ipcMain.handle(CH.ping, () => 'pong')
}
