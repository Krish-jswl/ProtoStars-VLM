import { test } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { PrivacyPipelineRunner } from '../extension/content/privacy_pipeline_runner.js';

test('a local password reference can be inserted into a password input', async () => {
  const dom = new JSDOM('<input id="password" type="password" autocomplete="current-password">');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;

  const field = document.getElementById('password');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 30 });
  const pipeline = new PrivacyPipelineRunner();
  pipeline.setSecrets({ password: 'local-only-password' }, false);

  const result = await pipeline.executeValidatedAction({
    type: 'type_local',
    target: 'password',
    args: { secret_ref: 'password' }
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.verified, true);
  assert.strictEqual(field.value, 'local-only-password');
  assert.ok(!JSON.stringify(result).includes('local-only-password'));
});

test('ordinary task text is never written into an email field', async () => {
  const dom = new JSDOM('<input id="email" type="email" autocomplete="email">');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;

  const field = document.getElementById('email');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 30 });
  const pipeline = new PrivacyPipelineRunner();
  const result = await pipeline.executeValidatedAction({
    type: 'type_local',
    target: 'email',
    args: { text: 'Study Cpp' }
  });

  assert.strictEqual(result.success, false);
  assert.match(result.error, /identity fields|secret_ref/);
  assert.strictEqual(field.value, '');
});

test('plain text is never written into a show-password text field', async () => {
  const dom = new JSDOM('<input id="password" type="text" autocomplete="current-password">');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;

  const field = document.getElementById('password');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 30 });

  const pipeline = new PrivacyPipelineRunner();
  const result = await pipeline.executeValidatedAction({
    type: 'type_local',
    target: 'password',
    args: { text: 'Run' }
  });

  assert.strictEqual(result.success, false);
  assert.match(result.error, /secret_ref/);
  assert.strictEqual(field.value, '');
});

test('plain task text can be inserted into a contenteditable title', async () => {
  const dom = new JSDOM('<div id="title" contenteditable="true" role="textbox"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;

  const field = document.getElementById('title');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 30 });

  const pipeline = new PrivacyPipelineRunner();
  const result = await pipeline.executeValidatedAction({
    type: 'type_local',
    target: 'title',
    args: { text: 'RUn' }
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(field.textContent, 'RUn');
});

test('repeated ordinary text insertion remains idempotent in a contenteditable', async () => {
  const dom = new JSDOM('<div id="message" contenteditable="true" role="textbox"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;

  const field = document.getElementById('message');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 30 });
  const pipeline = new PrivacyPipelineRunner();
  const action = {
    type: 'type_local',
    target: 'message',
    args: { text: 'Its done bro' }
  };

  const first = await pipeline.executeValidatedAction(action);
  const second = await pipeline.executeValidatedAction(action);
  field.textContent = 'Its done broIts done bro';
  const repaired = await pipeline.executeValidatedAction(action);

  assert.strictEqual(first.success, true);
  assert.strictEqual(second.success, true);
  assert.strictEqual(repaired.success, true);
  assert.strictEqual(field.textContent, 'Its done bro');
});

test('targeted Enter focuses and reaches a contenteditable message editor', async () => {
  const dom = new JSDOM('<div id="message" contenteditable="true" role="textbox"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;

  const field = document.getElementById('message');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 30 });
  let received = 0;
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') received += 1;
  });
  document.body.focus();

  const pipeline = new PrivacyPipelineRunner();
  const result = await pipeline.executeValidatedAction({
    type: 'keypress',
    target: 'message',
    args: { key: 'Enter' }
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(document.activeElement, field);
  assert.strictEqual(received, 1);
});

test('empty-target Enter keypress reaches the active contenteditable editor', async () => {
  const dom = new JSDOM('<form><div id="title" contenteditable="true" role="textbox"></div></form>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Image = dom.window.Image;
  const field = document.getElementById('title');
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 30 });
  let submitted = 0;
  dom.window.HTMLFormElement.prototype.requestSubmit = function () { submitted++; };
  field.focus();

  const pipeline = new PrivacyPipelineRunner();
  const result = await pipeline.executeValidatedAction({
    type: 'keypress',
    target: '',
    args: { key: 'Enter' }
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(submitted, 1);
});
