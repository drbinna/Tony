'use strict';
/**
 * Regression tests for the Terraform hand-off engine (browser/terraform.js).
 * Runs the real bundled HCL parser as the gate. `node test/terraform-test.js`.
 *
 * Covers the three lesson shapes (create, failed launch, modify) plus every
 * hardening: H1 commit-time body parse, H2 import-id format fallback, H4 map
 * collisions, and the double-wrapper normalization a live session surfaced
 * (the model emitting a full `variable "x" { … }` block as the body).
 */
const { parse } = require('@cdktf/hcl2json');
const { TerraformArtifact, block } = require('../browser/terraform');

const quiet = { warn: () => {}, log: () => {} };
const A = () => new TerraformArtifact({ region: 'us-east-1', accountAlias: 'Goblin Labs AWS tutor', sessionId: 'test', parse, log: quiet });
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)));

(async () => {
  // [1] S3 create — happy path
  console.log('\n[1] S3 create');
  let tf = A();
  await tf.applyVariable({ name: 'bucket_name', body: 'type    = string\ndefault = "goblin-lab-demo-2"' });
  ok((await tf.applyResource({ op: 'create', type: 'aws_s3_bucket', name: 'lesson_demo_2', step: 'Create bucket', body: 'bucket = var.bucket_name', import_id: 'goblin-lab-demo-2' })).ok, 'bucket committed');
  ok((await tf.applyResource({ op: 'create', type: 'aws_s3_bucket_server_side_encryption_configuration', name: 'lesson_demo_2', step: 'SSE', body: 'bucket = aws_s3_bucket.lesson_demo_2.id\nrule {\n  apply_server_side_encryption_by_default {\n    sse_algorithm = "AES256"\n  }\n}', import_id: 'goblin-lab-demo-2' })).ok, 'SSE with nested blocks committed');
  await tf.applyOutput({ name: 'bucket_arn', body: 'value = aws_s3_bucket.lesson_demo_2.arn' });
  let b = await tf.build({ lessonGoal: 'S3', steps: ['Created bucket'] });
  ok(b.ok, 'whole-file parses');
  ok((b.mainTf.match(/^import \{/gm) || []).length === 2, '2 multi-line import blocks');
  ok(b.mainTf.includes('required_version = ">= 1.5"'), 'pinned skeleton');

  // [2] Failed EC2 launch — instance omitted, SG kept, id gates
  console.log('\n[2] Failed EC2 launch');
  tf = A();
  tf.addFailure({ step: 'Launch t3.micro', error: 'vCPU quota is 0 in us-east-1', remediation: 'request an increase via Service Quotas' });
  const bad = await tf.applyResource({ op: 'create', type: 'aws_security_group', name: 'golden', step: 'HTTP SG', body: 'name = "launch-wizard-1"', import_id: 'not-a-real-id' });
  ok(bad.ok && /REPLACE_ME/.test(bad.warning || ''), 'H2: hallucinated sg id → REPLACE_ME fallback');
  b = await tf.build({ lessonGoal: 'EC2', steps: [] });
  ok(!/aws_instance/.test(b.mainTf), 'no aws_instance (launch failed)');
  ok(/aws_security_group/.test(b.mainTf) && /REPLACE_ME/.test(b.mainTf) && /TODO\(dev\)/.test(b.mainTf), 'SG kept with REPLACE_ME + TODO');
  ok(/vCPU quota is 0/.test(b.readme) && /Service Quotas/.test(b.readme), 'failure + remediation in README');
  const good = await tf.applyResource({ op: 'create', type: 'aws_security_group', name: 'golden', body: 'name = "launch-wizard-1"', import_id: 'sg-0a1b2c3d4e5f60718' });
  ok(good.ok && /modify/.test(good.warning || ''), 'H4: create-on-existing → modify + warn');
  ok(/id = "sg-0a1b2c3d4e5f60718"/.test((await tf.build({ lessonGoal: 'x', steps: [] })).mainTf), 'valid sg id rendered');

  // [3] Modify mid-session — full-body replacement, no duplicate block
  console.log('\n[3] Modify (versioning)');
  tf = A();
  await tf.applyResource({ op: 'create', type: 'aws_s3_bucket', name: 'demo', step: 'Create bucket', body: 'bucket = "goblin-modify-demo"', import_id: 'goblin-modify-demo' });
  await tf.applyResource({ op: 'modify', type: 'aws_s3_bucket', name: 'demo', step: 'Enable versioning', body: 'bucket = "goblin-modify-demo"\nversioning {\n  enabled = true\n}', import_id: 'goblin-modify-demo' });
  b = await tf.build({ lessonGoal: 'x', steps: [] });
  ok(tf.resourceCount === 1 && (b.mainTf.match(/resource "aws_s3_bucket" "demo"/g) || []).length === 1, 'single bucket block after modify');
  ok(/versioning/.test(b.mainTf) && /Enable versioning/.test(b.mainTf), 'body replaced + step comment updated');

  // [H1] compressed one-liner body rejected at commit
  console.log('\n[hardening]');
  tf = A();
  const h1 = await tf.applyResource({ op: 'create', type: 'aws_s3_bucket_server_side_encryption_configuration', name: 'x', body: 'rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }', import_id: 'b' });
  ok(!h1.ok && /malformed/.test(h1.error) && tf.resourceCount === 0, 'H1: compressed body rejected, never enters map');

  // [H4] delete rules
  ok((await tf.applyResource({ op: 'delete', type: 'aws_s3_bucket', name: 'ghost' })).warning?.includes('unknown'), 'H4: delete-unknown warns + ignored');

  // Double-wrapper normalization (the live bug): model wraps var/output bodies
  tf = A();
  await tf.applyVariable({ name: 'bucket_name', body: 'variable "bucket_name" {\n  type    = string\n  default = "b"\n}' });
  await tf.applyResource({ op: 'create', type: 'aws_s3_bucket', name: 'd', body: 'bucket = var.bucket_name', import_id: 'b' });
  await tf.applyOutput({ name: 'arn', body: 'output "arn" {\n  value = aws_s3_bucket.d.arn\n}' });
  b = await tf.build({ lessonGoal: 'x', steps: [] });
  ok((b.mainTf.match(/variable "bucket_name"/g) || []).length === 1, 'wrapper: variable de-duplicated');
  ok((b.mainTf.match(/output "arn"/g) || []).length === 1, 'wrapper: output de-duplicated');
  ok(block('variable', ['x'], 'type = string') === 'variable "x" {\n  type = string\n}', 'wrapper: inside-only body untouched');
  ok(b.ok, 'normalized file parses');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
