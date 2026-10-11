// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HostCard, HostDirectoryFlow } from '../src/client/index.tsx'

vi.mock('@cuteafd/dsh-hosts/remote', () => ({ default: {} }))
afterEach(cleanup)

const hosts = ['rhea', 'moa'].map(alias => ({ alias, hostname: alias, user: 'tj', port: 22, confirmed: true }))
const listing = { path: '/remote/project', home: '/remote', crumbs: [], entries: [], truncated: false }
function fixture() {
  const api = {
    list: vi.fn(async () => ({ ok: true, value: hosts })),
    listDirectory: vi.fn(async () => ({ ok: true, value: listing })),
    createDirectory: vi.fn(async () => ({ ok: true, value: '/remote/project/new' })),
    scan: vi.fn(async () => ({ ok: true, value: { confirmation: 'pending', fingerprint: 'SHA256:verified-independently' } })),
    confirm: vi.fn(async () => ({ ok: true, value: { host: hosts[0], publicKey: 'ssh-ed25519 dedicated-public-key' } })),
    probe: vi.fn(),
  }
  const props = { api: api as never, open: true, busy: false, onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn() }
  return { api, props }
}

it('requires a host before browsing and propagates its identity on commit', async () => {
  const { api, props } = fixture()
  render(<HostDirectoryFlow {...props} />)
  await screen.findByRole('option', { name: 'rhea (tj@rhea)' })
  expect(api.listDirectory).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Use this directory' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('SSH host'), { target: { value: 'rhea' } })
  await waitFor(() => expect(screen.getByLabelText('Absolute remote path')).toHaveProperty('value', listing.path))
  fireEvent.click(screen.getByRole('button', { name: 'Use this directory' }))
  expect(api.listDirectory).toHaveBeenCalledWith('rhea', undefined)
  expect(props.onPicked).toHaveBeenCalledWith('/remote/project', 'rhea')
})

it('creates a folder on the selected remote host then browses the returned canonical path', async () => {
  const { api, props } = fixture()
  render(<HostDirectoryFlow {...props} />)
  await screen.findByRole('option', { name: 'moa (tj@moa)' })
  fireEvent.change(screen.getByLabelText('SSH host'), { target: { value: 'moa' } })
  await screen.findByLabelText('New folder name')
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
  await waitFor(() => expect(api.listDirectory).toHaveBeenLastCalledWith('moa', '/remote/project/new'))
  expect(api.createDirectory).toHaveBeenCalledWith('moa', '/remote/project', 'new')
})

it('ignores a browse reply that arrives after cancellation and reopening', async () => {
  const { api, props } = fixture()
  let resolve!: (value: { ok: boolean; value: typeof listing }) => void
  api.listDirectory.mockReturnValueOnce(new Promise(accept => { resolve = accept }))
  const view = render(<HostDirectoryFlow {...props} />)
  await screen.findByRole('option', { name: 'rhea (tj@rhea)' })
  fireEvent.change(screen.getByLabelText('SSH host'), { target: { value: 'rhea' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
  expect(props.onCancel).toHaveBeenCalledTimes(1)
  view.rerender(<HostDirectoryFlow {...props} open={false} />)
  view.rerender(<HostDirectoryFlow {...props} />)
  await act(async () => { resolve({ ok: true, value: listing }) })
  expect(screen.queryByLabelText('New folder name')).toBeNull()
  expect(props.onPicked).not.toHaveBeenCalled()
})

it('requires explicit fingerprint confirmation, does not send a key during scan, and clears pasted material', async () => {
  const { api } = fixture()
  render(<HostCard api={api as never} view="page" />)
  for (const field of ['alias', 'hostname', 'user']) fireEvent.change(screen.getByLabelText(field), { target: { value: field === 'user' ? 'tj' : 'rhea' } })
  const input = screen.getByLabelText('Dedicated private key (optional; blank generates one)')
  fireEvent.change(input, { target: { value: 'dedicated-private-material' } })
  fireEvent.click(screen.getByRole('button', { name: 'Scan host fingerprint' }))
  await screen.findByText('SHA256:verified-independently')
  expect(api.scan).toHaveBeenCalledWith({ alias: 'rhea', hostname: 'rhea', user: 'tj', port: 22 })
  expect(api.confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'I verified this fingerprint' }))
  await screen.findByText('ssh-ed25519 dedicated-public-key')
  expect(api.confirm).toHaveBeenCalledWith('pending', 'SHA256:verified-independently', 'dedicated-private-material')
  expect(input).toHaveProperty('value', '')
})
