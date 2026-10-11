/** Client-safe operator SSH host metadata; never includes deployment keys or paths. */
export interface HostSpec { alias: string; hostname: string; user: string; port: number }
export interface HostView extends HostSpec { confirmed: boolean }
