import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage } from './errors.ts'

describe('reading an error', () => {
  test('a plain object from supabase-js, which is the whole point', () => {
    // Not an Error instance. `instanceof Error` on this returns false, which is
    // how the real message used to get thrown away.
    const postgrestError = {
      message: 'The Pratt family is booked at that time.',
      details: null,
      hint: null,
      code: 'P0001',
    }
    assert.equal(
      errorMessage(postgrestError, 'That day could not be deleted.'),
      'The Pratt family is booked at that time.'
    )
  })

  test('a real Error still works', () => {
    assert.equal(errorMessage(new Error('Network request failed'), 'nope'), 'Network request failed')
  })

  test('a hint is carried along, because it is usually the actionable half', () => {
    assert.equal(
      errorMessage({ message: 'Permission denied.', hint: 'Ask a ward admin.' }, 'nope'),
      'Permission denied. Ask a ward admin.'
    )
  })

  test('details stand in when there is no message', () => {
    assert.equal(errorMessage({ details: 'Key is still referenced.' }, 'nope'), 'Key is still referenced.')
  })

  test('a repeated hint is not said twice', () => {
    assert.equal(errorMessage({ message: 'Denied.', hint: 'Denied.' }, 'nope'), 'Denied.')
  })

  test('a bare string is the message', () => {
    assert.equal(errorMessage('Something broke', 'nope'), 'Something broke')
  })

  test('anything useless falls back', () => {
    for (const useless of [null, undefined, {}, { message: '' }, { message: 42 }, 7, '']) {
      assert.equal(errorMessage(useless, 'fallback'), 'fallback')
    }
  })
})
