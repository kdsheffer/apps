import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { digitsOf, formatPhone, isPlausiblePhone, isPlausibleEmail } from './phone.ts'

describe('phone numbers', () => {
  test('digits survive whatever punctuation surrounds them', () => {
    for (const written of ['8015550123', '801-555-0123', '(801) 555-0123', '801.555.0123']) {
      assert.equal(digitsOf(written), '8015550123')
    }
  })

  test('a ten-digit number is formatted, with or without the country code', () => {
    assert.equal(formatPhone('8015550123'), '(801) 555-0123')
    assert.equal(formatPhone('18015550123'), '(801) 555-0123')
    assert.equal(formatPhone('+1 801 555 0123'), '(801) 555-0123')
  })

  test('anything that is not a US number is left exactly as it was typed', () => {
    assert.equal(formatPhone('+44 20 7946 0018'), '+44 20 7946 0018')
    assert.equal(formatPhone('801555'), '801555')
    assert.equal(formatPhone(''), '')
  })

  test('plausibility matches what the database will accept', () => {
    assert.equal(isPlausiblePhone('5550123'), true)
    assert.equal(isPlausiblePhone('555012'), false)
    assert.equal(isPlausiblePhone('8015550123'), true)
    assert.equal(isPlausiblePhone('1234567890123456'), false)
  })
})

describe('email addresses', () => {
  test('ordinary addresses pass', () => {
    assert.equal(isPlausibleEmail('someone@example.com'), true)
    assert.equal(isPlausibleEmail('  someone@example.co.uk '), true)
  })

  test('obvious typos do not', () => {
    for (const bad of ['someone', 'someone@', '@example.com', 'someone@example', 'a b@c.com']) {
      assert.equal(isPlausibleEmail(bad), false, `${bad} should be rejected`)
    }
  })
})

