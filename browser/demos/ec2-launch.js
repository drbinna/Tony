'use strict';
/**
 * Scripted EC2 "launch an instance" demo (see DemoRail in ../demo.js).
 *
 * PREREQ: the demo account must have vCPU quota. Fresh accounts default to 0 for
 * t3.micro, so the final launch fails with "requested more vCPU capacity than
 * your current limit". Raise "Running On-Demand Standard instances"
 * (Service Quotas → EC2 → L-1216C47A) to >= 4 before demoing, or this ends on
 * the quota error instead of a running instance.
 *
 * Targets are the real console role/name pairs captured from live sessions.
 * Console labels drift — dry-run once and tune `targetName`s if a step misses
 * (a demo-act ok:false in the transcript points at the offending step).
 * Start it by saying "run the EC2 demo" (or launch with TONY_DEMO=ec2).
 */
module.exports = {
  name: 'ec2-launch',
  intro:
    "Let's launch a real EC2 server together. I'll take it one step at a time and " +
    "wait for your go before each move — and I'll save the Terraform as we build.",
  steps: [
    {
      say:
        "Start on the EC2 dashboard. See the glowing Launch instance button? Say go and " +
        "I'll open the launch wizard — nothing is created yet.",
      act: { tool: 'click', role: 'link', targetName: 'Launch instance' },
    },
    {
      say:
        "We're on the launch form. First a name — I'll type goblin-demo-web into the " +
        "highlighted field. Ready?",
      act: { tool: 'type', role: 'textbox', targetName: 'e.g. My Web Server', text: 'goblin-demo-web' },
    },
    {
      say:
        "The image is Amazon Linux 2023, already selected — free-tier friendly and a great " +
        "default. Nothing to click here; say next.",
      act: null,
    },
    {
      say:
        "Instance type is t3.micro — two vCPUs, one gig of memory, free-tier eligible. " +
        "That's the highlighted box. Say next to keep it.",
      act: { tool: 'highlight', role: 'button', targetName: 't3.micro' },
    },
    {
      say:
        "One security note before we launch: the default network setting allows SSH from " +
        "anywhere. Fine for a throwaway demo, but in production you'd lock that to your own " +
        "IP. Say launch it and I'll click the Launch instance button to create the server — " +
        "this is the state-changing moment.",
      act: { tool: 'click', role: 'button', targetName: 'Launch instance' },
    },
    {
      say:
        "A key-pair dialog opened. We don't need SSH for the demo, so I'll pick Proceed " +
        "without a key pair. Say go.",
      act: { tool: 'click', role: 'radio', targetName: 'PROCEED_WITHOUT' },
    },
    {
      say:
        "Last click — the Launch instance button in this dialog actually creates it. " +
        "Say launch and it's live.",
      act: { tool: 'click', role: 'button', targetName: 'Launch instance' },
      // This is the create moment — commit the Terraform twin. AMI via a data
      // source so the file is portable (no hardcoded ami-… id).
      data: [{
        type: 'aws_ami', name: 'al2023',
        body:
          'most_recent = true\n' +
          'owners      = ["amazon"]\n' +
          'filter {\n' +
          '  name   = "name"\n' +
          '  values = ["al2023-ami-*-x86_64"]\n' +
          '}',
      }],
      resource: {
        type: 'aws_instance', name: 'web', op: 'create',
        body:
          'ami           = data.aws_ami.al2023.id\n' +
          'instance_type = "t3.micro"\n' +
          'tags = {\n' +
          '  Name = "goblin-demo-web"\n' +
          '}',
      },
      outputs: [{ name: 'instance_id', body: 'value = aws_instance.web.id' }],
    },
  ],
  outro:
    "Your instance is launching. I've saved the Terraform for it — an aws_instance plus an " +
    "AMI data source and an output — ask for your files whenever you want them. When we're " +
    "done, just say so and I'll walk you through terminating it so it stops costing anything.",
};
