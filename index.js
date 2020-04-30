// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const core = require("@actions/core");
const { runDeploy } = require("./code-build");
const assert = require("assert");

/* istanbul ignore next */
if (require.main === module) {
  run();
}

module.exports = run;

async function run() {
  console.log("*****STARTING CODEDEPLOY*****");
  try {
    const deployment = await runDeploy();
    core.setOutput("aws-deployment-id", deployment.deploymentId);

    // Signal the outcome
    assert(deployment.deploymentId === "Succeeded", "Deployment succeeded");
  } catch (error) {
    core.setFailed(
      `Message : ${error.message}. Code ${error.code}. DeploymentId ${error.deploymentId}`
    );
  } finally {
    console.log("*****CODEDEPLOY COMPLETE*****");
  }
}
