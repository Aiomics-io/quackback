/**
 * Real-DB coverage for the metadata merge on an EXISTING user. Re-identifying
 * a known user with attributes (via the API, the widget identify route, or by
 * principal) renders the
 * `metadata - <removals>::text[]` expression, which Postgres only accepts when
 * the removal keys arrive as a real array — with no removals, with some, and
 * with both at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { eq, principal, user, userAttributeDefinitions } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

vi.mock('@/lib/server/cache', () => ({
  cacheDel: vi.fn(),
  CACHE_KEYS: { PRINCIPAL_BY_USER: (id: string) => `principal:user:${id}` },
}))

import { identifyPortalUser, updatePortalUser } from '../user.identify'
import { mergedMetadataSql } from '../user.attributes'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: user.id, metadata: user.metadata }).from(user).limit(0)
    await db.select({ id: principal.id }).from(principal).limit(0)
    await db.select({ id: userAttributeDefinitions.id }).from(userAttributeDefinitions).limit(0)
  },
})

const runSuffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function readMetadata(userId: string) {
  const [row] = await testDb
    .select({ metadata: user.metadata })
    .from(user)
    .where(eq(user.id, userId as never))
  return JSON.parse(row.metadata ?? '{}') as Record<string, unknown>
}

describe.skipIf(!fixture.available)('identify metadata merge on an existing user', () => {
  let planKey: string
  let orgKey: string

  beforeEach(async () => {
    await fixture.begin()
    const suffix = runSuffix().replace(/[^a-z0-9]/g, '_')
    planKey = `plan_${suffix}`
    orgKey = `org_${suffix}`
    await testDb.insert(userAttributeDefinitions).values([
      { key: planKey, label: 'Plan', type: 'string' },
      { key: orgKey, label: 'Organization', type: 'string' },
    ])
  })
  afterEach(() => fixture.rollback())
  afterAll(() => fixture.close())

  it('updates attributes when nothing is removed', async () => {
    const email = `meta-update-${runSuffix()}@example.com`
    const first = await identifyPortalUser({
      email,
      name: 'Meta U',
      attributes: { [planKey]: 'free', [orgKey]: 'Acme' },
    })
    expect(first.created).toBe(true)

    const again = await identifyPortalUser({ email, attributes: { [planKey]: 'pro' } })

    expect(again.created).toBe(false)
    expect(await readMetadata(again.userId)).toMatchObject({ [planKey]: 'pro', [orgKey]: 'Acme' })
  })

  it('removes an attribute set to null and merges the rest', async () => {
    const email = `meta-remove-${runSuffix()}@example.com`
    await identifyPortalUser({ email, attributes: { [planKey]: 'free', [orgKey]: 'Acme' } })

    const again = await identifyPortalUser({
      email,
      attributes: { [planKey]: 'pro', [orgKey]: null },
    })

    const metadata = await readMetadata(again.userId)
    expect(metadata[planKey]).toBe('pro')
    expect(metadata).not.toHaveProperty(orgKey)
  })

  it('merges with no removals, as the widget identify route does', async () => {
    const email = `meta-widget-${runSuffix()}@example.com`
    const created = await identifyPortalUser({ email, attributes: { [planKey]: 'free' } })

    await testDb
      .update(user)
      .set({ metadata: mergedMetadataSql([], { [orgKey]: 'Acme' }) })
      .where(eq(user.id, created.userId as never))

    expect(await readMetadata(created.userId)).toMatchObject({
      [planKey]: 'free',
      [orgKey]: 'Acme',
    })
  })

  it('updates attributes by principal (updatePortalUser)', async () => {
    const email = `meta-principal-${runSuffix()}@example.com`
    const created = await identifyPortalUser({ email, attributes: { [planKey]: 'free' } })

    await updatePortalUser(created.principalId, {
      attributes: { [planKey]: null, [orgKey]: 'Acme' },
    })

    const metadata = await readMetadata(created.userId)
    expect(metadata).not.toHaveProperty(planKey)
    expect(metadata[orgKey]).toBe('Acme')
  })
})
