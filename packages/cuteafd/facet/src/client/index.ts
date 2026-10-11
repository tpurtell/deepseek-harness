/** Load the locked console's same-origin palette and use the public DSH theme seam. */
import type { Context } from '@deepseek-ai/cordis'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

export const inject = ['theme']
export function apply(ctx: Context): void {
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = '/agent/theme.css'
  ctx.effect(() => { document.head.appendChild(stylesheet); return () => stylesheet.remove() }, 'cuteafd-facet: console palette')
  const aliases: Record<string, string> = {
    '--dsw-alias-bg-base': '--bg',
    '--dsw-alias-bg-layer-1': '--panel',
    '--dsw-alias-bg-layer-2': '--panel-2',
    '--dsw-alias-bg-overlay': '--panel',
    '--dsw-alias-border-l1': '--line',
    '--dsw-alias-border-l2': '--line-2',
    '--dsw-alias-label-primary': '--ink',
    '--dsw-alias-label-secondary': '--ink-2',
    '--dsw-alias-label-tertiary': '--muted',
    '--dsw-alias-brand-primary': '--target',
    '--dsw-alias-state-success-primary': '--accepted',
    '--dsw-alias-state-warn-primary': '--warn',
    '--dsw-alias-state-error-primary': '--bad',
    '--dsw-specific-sidebar-fill': '--panel',
  }
  const tokens: ThemeTokenOverrides = Object.fromEntries(Object.entries(aliases).map(([alias, variable]) => [alias, { light: `var(${variable})`, dark: `var(${variable})` }]))
  ctx.effect(() => ctx.theme.overrideTokens('cuteafd-facet', tokens), 'cuteafd-facet: DSH aliases')
}
