/** Operator-only SSH settings and host-first directory picker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import remote from '@cuteafd/dsh-hosts/remote'
import type { HostSpec, HostView } from '@cuteafd/dsh-hosts/types'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import './hosts.css'

type HostsRemote = Context['remote']['cuteafdHosts']

export function HostCard({ api, view }: { api: HostsRemote; view: 'summary' | 'page' }) {
  const [hosts, setHosts] = useState<HostView[]>([])
  const [spec, setSpec] = useState<HostSpec>({ alias: '', hostname: '', user: '', port: 22 })
  const [privateKey, setPrivateKey] = useState('')
  const [confirmation, setConfirmation] = useState<{ confirmation: string; fingerprint: string } | null>(null)
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let live = true; void api.list().then(result => { if (live && result.ok) setHosts(result.value) }); return () => { live = false } }, [api])
  if (view === 'summary') return <span>Dedicated keys and explicitly confirmed SSH hosts. Tools execute remotely only.</span>
  const scan = async () => {
    setBusy(true); setError(''); setConfirmation(null); setPublicKey('')
    try {
      const result = await api.scan(spec)
      if (!result.ok) throw new Error(result.error.message)
      setConfirmation(result.value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Host scan failed') }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (confirmation === null) return
    setBusy(true); setError('')
    try {
      const result = await api.confirm(confirmation.confirmation, confirmation.fingerprint, privateKey === '' ? undefined : privateKey)
      if (!result.ok) throw new Error('Host registration failed. Check the fingerprint and an unencrypted Ed25519 key.')
      setPublicKey(result.value.publicKey); setHosts(current => [...current.filter(host => host.alias !== result.value.host.alias), result.value.host]); setConfirmation(null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Host registration failed') }
    finally { setPrivateKey(''); setBusy(false) }
  }
  return <section className="cuteafd-hosts">
    <h2>Remote execution hosts</h2>
    <p>Register any Linux, macOS or WSL host with bash. Verify the advertised fingerprint independently before confirming. Never paste an existing personal key; generate a dedicated key instead.</p>
    <ul>{hosts.map(host => <li key={host.alias}><strong>{host.alias}</strong> {host.user}@{host.hostname}:{host.port}</li>)}</ul>
    <form onSubmit={event => { event.preventDefault(); void scan() }}>
      {(['alias', 'hostname', 'user'] as const).map(field => <label key={field}>{field}<input required autoComplete="off" value={spec[field]} disabled={busy || confirmation !== null} onChange={event => setSpec(current => ({ ...current, [field]: event.target.value }))} /></label>)}
      <label>Port<input type="number" min={1} max={65535} required value={spec.port} disabled={busy || confirmation !== null} onChange={event => setSpec(current => ({ ...current, port: Number(event.target.value) }))} /></label>
      <label>Dedicated private key (optional; blank generates one)<textarea autoComplete="off" spellCheck={false} value={privateKey} disabled={busy} onChange={event => setPrivateKey(event.target.value)} /></label>
      <Button disabled={busy || confirmation !== null} onClick={() => { void scan() }}>Scan host fingerprint</Button>
    </form>
    {confirmation !== null && <div className="cuteafd-host-confirm"><p>Advertised Ed25519 fingerprint</p><code>{confirmation.fingerprint}</code><p>This is not verified automatically. Compare it with the host's fingerprint through a trusted channel.</p><Button disabled={busy} onClick={() => { void confirm() }}>I verified this fingerprint</Button><Button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button></div>}
    {publicKey !== '' && <div><p>Add this dedicated public key to the remote account's authorized_keys, then probe the host.</p><pre>{publicKey}</pre></div>}
    {hosts.map(host => <Button key={host.alias} disabled={busy} onClick={() => { setBusy(true); setError(''); void api.probe(host.alias).then(result => { setError(result.ok ? `${host.alias}: ${result.value.platform} ${result.value.machine} ${result.value.libc}` : result.error.message) }).finally(() => setBusy(false)) }}>Probe {host.alias}</Button>)}
    {error !== '' && <p role="status">{error}</p>}
  </section>
}

export function HostDirectoryFlow(props: DirectoryFlowOwnerProps & { api: HostsRemote }) {
  const [hosts, setHosts] = useState<HostView[]>([])
  const [host, setHost] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [path, setPath] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const cancel = () => { request.current++; props.onCancel() }
  useEffect(() => {
    const generation = ++request.current
    if (!props.open) return
    setListing(null); setHost(''); setError(''); setBusy(false); setPath(''); setNewFolder(''); setHosts([])
    void props.api.list().then(result => { if (request.current === generation) { if (result.ok) setHosts(result.value); else setError(result.error.message) } }).catch(() => { if (request.current === generation) setError('Registered hosts unavailable') })
    return () => { request.current++ }
  }, [props.open, props.api])
  const browse = async (alias: string, directory?: string, folder?: string) => {
    const generation = ++request.current
    setBusy(true); setError(''); setListing(null)
    try {
      if (folder !== undefined) {
        const created = await props.api.createDirectory(alias, directory!, folder)
        if (request.current !== generation) return
        if (!created.ok) throw new Error(created.error.message)
        directory = created.value
        setNewFolder('')
      }
      const result = await props.api.listDirectory(alias, directory)
      if (request.current !== generation) return
      if (!result.ok) throw new Error(result.error.message)
      setListing(result.value); setPath(result.value.path)
    } catch (reason) { if (request.current === generation) setError(reason instanceof Error ? reason.message : 'Remote directory unavailable') }
    finally { if (request.current === generation) setBusy(false) }
  }
  return <Modal open={props.open} onClose={cancel} closeLabel="Cancel" title="Select remote workspace" footer={<><Button disabled={props.busy} onClick={cancel}>Cancel</Button><Button disabled={busy || props.busy || listing === null || host === ''} onClick={() => { if (listing !== null && host !== '') { request.current++; props.onPicked(listing.path, host) } }}>Use this directory</Button></>}>
    <section className="cuteafd-hosts">
      <label>SSH host<select value={host} disabled={busy || props.busy} onChange={event => { const alias = event.target.value; setHost(alias); if (alias !== '') void browse(alias); else setListing(null) }}><option value="">Choose a confirmed host</option>{hosts.map(item => <option key={item.alias} value={item.alias}>{item.alias} ({item.user}@{item.hostname})</option>)}</select></label>
      {hosts.length === 0 && <p>Register and confirm a host on the Plugins page first.</p>}
      {host !== '' && <form onSubmit={event => { event.preventDefault(); void browse(host, path) }}><label>Absolute remote path<input value={path} disabled={busy || props.busy} onChange={event => setPath(event.target.value)} /></label><Button disabled={busy || props.busy} onClick={() => { void browse(host, path) }}>Browse</Button></form>}
      {listing !== null && <><nav>{listing.crumbs.map(crumb => <Button key={crumb.path} disabled={busy || props.busy} onClick={() => { void browse(host, crumb.path) }}>{crumb.name}</Button>)}</nav><ul>{listing.entries.map(entry => <li key={entry.path}><Button disabled={busy || props.busy} onClick={() => { void browse(host, entry.path) }}>{entry.name}</Button></li>)}</ul>{listing.truncated && <p>Only the first 1000 folders are shown.</p>}<form onSubmit={event => { event.preventDefault(); void browse(host, listing.path, newFolder) }}><label>New folder name<input value={newFolder} disabled={busy || props.busy} onChange={event => setNewFolder(event.target.value)} /></label><Button disabled={busy || props.busy || newFolder.trim() === ''} onClick={() => { void browse(host, listing.path, newFolder) }}>Create folder</Button></form></>}
      {busy && <p role="status">Connecting to the remote host...</p>}
      {error !== '' && <p role="alert">{error}</p>}
    </section>
  </Modal>
}

export const inject = ['remote', 'slots']
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote)
  ctx.effect(() => unmount, 'cuteafd-hosts: Remote contribution')
  // This plugin mounts its own namespace; injecting it upfront would deadlock activation.
  const api = ctx.get('remote.cuteafdHosts')
  if (api === undefined) throw new Error('SSH host Remote namespace did not mount')
  ctx.slots.inject('plugins.item', () => ctx.slots.register({ name: 'plugins.item', id: 'cuteafd-hosts', order: 35, label: () => 'SSH hosts', inject: () => ({ api }) }, HostCard))
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
    yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: () => ({ api }) }, HostDirectoryFlow)
    yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: () => ({ api }) }, HostDirectoryFlow)
  }))
}
