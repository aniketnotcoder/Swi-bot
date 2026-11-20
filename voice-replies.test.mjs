import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installTelegramVoiceReplies,
  selectVoiceClip,
  toggleVoiceTone
} from './voice-replies.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('routes fixed Hindi voice clips for join, links, bill, QR, pending, and tracking', () => {
  assert.equal(selectVoiceClip('Join our channel then tap Check Joined'), 'join');
  assert.equal(selectVoiceClip('Assalamu alaikum. Send cart link and address link'), 'start');
  assert.equal(selectVoiceClip('Bill ready: To Pay ₹448'), 'bill');
  assert.equal(selectVoiceClip('Payment QR ready'), 'qr');
  assert.equal(selectVoiceClip('Payment pending, check payment'), 'pending');
  assert.equal(selectVoiceClip('Swiggy tracking link: https://swiggy.com/orders/secret'), 'tracking');
});

test('stern mood changes bill reminder clip without changing tracking or payment truth', () => {
  assert.equal(selectVoiceClip('Bill ready', 'stern'), 'stern');
  assert.equal(selectVoiceClip('Payment pending, check payment', 'stern'), 'pending');
  assert.equal(selectVoiceClip('Tracking link ready', 'stern'), 'tracking');
});

test('Telegram customer replies get one fixed voice note; group and boss chats are skipped', async () => {
  const sent = [];
  const telegram = {
    async sendMessage(...args) { sent.push(['text', ...args]); return { message_id: 1 }; },
    async sendVoice(...args) { sent.push(['voice', ...args]); return { message_id: 2 }; },
    async editMessageText(...args) { sent.push(['edit', ...args]); return { message_id: 1 }; },
    async sendPhoto(...args) { sent.push(['photo', ...args]); return { message_id: 3 }; }
  };
  const installed = installTelegramVoiceReplies(telegram, {
    isBoss: id => String(id) === '12345',
    logger: { info() {}, warn() {} }
  });
  assert.equal(installed.enabled, true);

  await telegram.sendMessage(23456, 'Your bill is ready. To Pay ₹448');
  await telegram.sendMessage(-10012345, 'Group update');
  await telegram.sendMessage(12345, 'Boss update');
  await telegram.sendPhoto(23456, 'qr-photo', { caption: 'Payment QR ready' });
  await tick();
  await tick();

  const voiceRows = sent.filter(row => row[0] === 'voice');
  assert.equal(voiceRows.length, 2);
  assert.equal(voiceRows[0][1], '23456');
  assert.match(voiceRows[0][2].filename, /bill\.mp3$/);
  assert.match(voiceRows[1][2].filename, /qr\.mp3$/);
  installed.uninstall();
});

test('/voice toggles between normal and mildly stern fixed clips', () => {
  const id = `test-${Date.now()}`;
  assert.equal(toggleVoiceTone(id), 'stern');
  assert.equal(selectVoiceClip('Bill amount. Confirm only if correct.', 'stern'), 'stern');
  assert.equal(toggleVoiceTone(id), 'normal');
  assert.equal(selectVoiceClip('Bill ready', 'normal'), 'bill');
});
