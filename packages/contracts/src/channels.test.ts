import { describe, expect, it } from 'vitest';
import {
  ChannelFlagsResponse,
  DevSmsSendRequest,
  DevUssdRequest,
  SmsInboundAck,
  SmsInboundWebhook,
  UssdCallbackRequest,
  UssdResponseText,
} from './channels';

describe('inbound SMS', () => {
  it('accepts an aggregator message and refuses malformed ids and huge texts', () => {
    const ok = SmsInboundWebhook.parse({
      messageId: 'ATXid_1234abcd',
      from: '+251911234567',
      to: '8123',
      text: '1234#1#50',
    });
    expect(ok.text).toBe('1234#1#50');
    expect(SmsInboundWebhook.safeParse({ ...ok, text: '' }).success).toBe(true);
    expect(SmsInboundWebhook.safeParse({ ...ok, messageId: '' }).success).toBe(false);
    expect(SmsInboundWebhook.safeParse({ ...ok, messageId: 'has space' }).success).toBe(false);
    expect(SmsInboundWebhook.safeParse({ ...ok, messageId: 'x'.repeat(129) }).success).toBe(false);
    expect(SmsInboundWebhook.safeParse({ ...ok, text: 'x'.repeat(1_601) }).success).toBe(false);
    expect(SmsInboundWebhook.safeParse({ ...ok, from: '' }).success).toBe(false);
  });

  it('acknowledges with the outcome and the reply', () => {
    expect(
      SmsInboundAck.parse({ received: true, outcome: 'bet_placed', replayed: false, reply: 'x' }),
    ).toBeTruthy();
    expect(
      SmsInboundAck.safeParse({ received: true, outcome: 'nope', replayed: false, reply: null })
        .success,
    ).toBe(false);
  });
});

describe('USSD callbacks', () => {
  it('reads the usual aggregator callback, text empty on the first one', () => {
    const first = UssdCallbackRequest.parse({
      sessionId: 'ATUid_abc',
      serviceCode: '*123#',
      phoneNumber: '+251911234567',
    });
    expect(first.text).toBe('');
    expect(
      UssdCallbackRequest.safeParse({ ...first, text: '1*1234*1*50', networkCode: '63601' })
        .success,
    ).toBe(true);
    expect(UssdCallbackRequest.safeParse({ ...first, text: '1'.repeat(501) }).success).toBe(false);
  });

  it('answers with CON or END within 182 characters', () => {
    expect(UssdResponseText.safeParse('CON Nahubet\n1 Place bet').success).toBe(true);
    expect(UssdResponseText.safeParse('END Bye').success).toBe(true);
    expect(UssdResponseText.safeParse('Bye').success).toBe(false);
    expect(UssdResponseText.safeParse(`END ${'x'.repeat(179)}`).success).toBe(false);
  });
});

describe('dev simulator and back office', () => {
  it('validates the simulator requests', () => {
    expect(DevSmsSendRequest.safeParse({ text: 'BAL' }).success).toBe(true);
    expect(DevSmsSendRequest.safeParse({ text: 'BAL', messageId: 'short' }).success).toBe(false);
    expect(DevUssdRequest.safeParse({ sessionId: 'dev-session-1', text: '' }).success).toBe(true);
    expect(DevUssdRequest.safeParse({ sessionId: 'bad id!', text: '' }).success).toBe(false);
  });

  it('shows the channel switches as read-only environment settings', () => {
    expect(
      ChannelFlagsResponse.parse({
        sms: { enabled: false, aggregator: 'mock', shortCode: '8123' },
        ussd: { enabled: false, aggregator: 'mock', serviceCode: '*123#' },
        source: 'environment',
      }).sms.enabled,
    ).toBe(false);
  });
});
