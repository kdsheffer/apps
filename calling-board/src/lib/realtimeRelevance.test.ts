import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { touches } from './realtimeRelevance.ts'

const onBoard = new Set(['group-1', 'group-2'])

describe('matching a change to the board on screen', () => {
  test('an insert into a group on this board counts', () => {
    assert.equal(
      touches({ eventType: 'INSERT', new: { id: 'p1', group_id: 'group-1' } }, 'group_id', onBoard),
      true
    )
  })

  test('an insert into another board’s group does not', () => {
    assert.equal(
      touches(
        { eventType: 'INSERT', new: { id: 'p1', group_id: 'group-elsewhere' } },
        'group_id',
        onBoard
      ),
      false
    )
  })

  test('a delete carrying the parent id counts', () => {
    assert.equal(
      touches(
        { eventType: 'DELETE', old: { id: 'p1', group_id: 'group-2' }, new: {} },
        'group_id',
        onBoard
      ),
      true
    )
  })

  test('a delete from another board does not', () => {
    assert.equal(
      touches(
        { eventType: 'DELETE', old: { id: 'p1', group_id: 'group-elsewhere' }, new: {} },
        'group_id',
        onBoard
      ),
      false
    )
  })

  test('a row moving off this board still counts, so the board it left hears about it', () => {
    assert.equal(
      touches(
        {
          eventType: 'UPDATE',
          old: { id: 'p1', group_id: 'group-1' },
          new: { id: 'p1', group_id: 'group-elsewhere' },
        },
        'group_id',
        onBoard
      ),
      true
    )
  })

  test('a row moving onto this board counts too', () => {
    assert.equal(
      touches(
        {
          eventType: 'UPDATE',
          old: { id: 'p1', group_id: 'group-elsewhere' },
          new: { id: 'p1', group_id: 'group-2' },
        },
        'group_id',
        onBoard
      ),
      true
    )
  })

  // Migration 010 sets REPLICA IDENTITY FULL so this shouldn't happen, but the
  // hook has to stay correct against a database that hasn't run it yet.
  test('a delete stripped to its primary key falls back to refetching', () => {
    assert.equal(
      touches({ eventType: 'DELETE', old: { id: 'p1' }, new: {} }, 'group_id', onBoard),
      true,
      'better an unnecessary refetch than a change nobody sees'
    )
  })

  test('an empty payload falls back to refetching', () => {
    assert.equal(touches({}, 'group_id', onBoard), true)
  })

  test('an empty board matches nothing it can identify', () => {
    assert.equal(
      touches({ eventType: 'INSERT', new: { group_id: 'group-1' } }, 'group_id', new Set()),
      false
    )
  })

  test('a non-string column value is treated as unknown', () => {
    assert.equal(
      touches({ eventType: 'INSERT', new: { group_id: null } }, 'group_id', onBoard),
      true
    )
  })
})
