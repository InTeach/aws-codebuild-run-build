// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const core = require("@actions/core");
const aws = require("aws-sdk");
const assert = require("assert");

module.exports = {
  runDeploy,
  deploy,
  waitForBuildEndTime,
  inputs2Parameters,
  githubInputs,
  buildSdk,
  logName,
  getAutoScalingGroupName,
};

async function runDeploy() {
  // get a codeBuild instance from the SDK
  const sdk = buildSdk();

  // Get Autoscaling group
  const autoScalingGroupName = await getAutoScalingGroupName(sdk);

  // Get input options for startBuild
  const params = inputs2Parameters(githubInputs(), autoScalingGroupName);

  return deploy(sdk, params);
}

async function getAutoScalingGroupName({ autoScaling }) {
  const {
    AutoScalingGroups: [inteachScalingGroup],
  } = await autoScaling.describeAutoScalingGroups().promise();

  return inteachScalingGroup.AutoScalingGroupName;
}

async function deploy(sdk, params) {
  // Start the deployment
  const deployment = await sdk.codeDeploy.createDeployment(params).promise();

  // Wait for the deployment to be "TODO"
  return waitForBuildEndTime(sdk, deployment.deploymentId);
}

async function waitForBuildEndTime(sdk, deploymentId) {
  const { codeDeploy, wait = 1000 * 30, backOff = 1000 * 15 } = sdk;

  // Get deployment status
  const deploymentStatus = await codeDeploy
    .getDeployment({ deploymentId })
    .promise();
  const status = deploymentStatus.deploymentInfo.status;
  const overview = deploymentStatus.deploymentInfo.deploymentOverview;
  const ongoingStatus = ["Created", "Queued", "InProgress", "Ready"];

  // Check if it's successful
  if (status === "Succeeded") {
    console.log(`[${status}] : `, overview);
    return {
      status,
      overview,
      deploymentId,
    };
  }

  // Check if it's ongoing
  if (ongoingStatus.includes(status)) {
    console.log(`[${status}] : `, overview);

    const newWait = wait + backOff;
    //Sleep before trying again
    await new Promise((resolve) => setTimeout(resolve, newWait));
    // Try again from the same token position
    return waitForBuildEndTime({ ...sdk, wait: newWait }, deploymentId);
  }

  // Now there is an error
  throw new Error({
    deploymentId,
    code: deploymentStatus.errorInformation.code,
    message: deploymentStatus.errorInformation.message,
  });
}

function githubInputs() {
  const applicationName = core.getInput("application-name", { required: true });
  const deploymentConfigName = core.getInput("deployment-config-name", {
    required: true,
  });
  const deploymentGroupName = core.getInput("deployment-group-name", {
    required: true,
  });
  const fileExistsBehavior = core.getInput("file-exists-behavior", {
    required: false,
  });
  const s3Bucket = core.getInput("s3-bucket");
  const s3Key = core.getInput("s3-key");
  const bundleType = core.getInput("bundle-type");

  return {
    applicationName,
    deploymentConfigName,
    deploymentGroupName,
    fileExistsBehavior,
    s3Bucket,
    s3Key,
    bundleType,
  };
}

function inputs2Parameters(inputs, autoScalingGroupName) {
  const {
    applicationName,
    deploymentConfigName,
    deploymentGroupName,
    fileExistsBehavior = "DISALLOW",
    s3Bucket,
    s3Key,
    bundleType = "zip",
  } = inputs;

  return {
    applicationName,
    autoRollbackConfiguration: {
      enabled: true,
      events: ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_REQUEST"],
    },
    deploymentConfigName,
    deploymentGroupName,
    fileExistsBehavior,
    targetInstances: {
      autoScalingGroups: [autoScalingGroupName],
    },
    revision: {
      revisionType: "S3",
      s3Location: {
        bucket: s3Bucket,
        bundleType,
        key: s3Key,
      },
    },
  };
}

function buildSdk({ local = false } = {}) {
  if (local) {
    const profile = new aws.SharedIniFileCredentials({
      profile: "academy-api-deploy",
    });

    aws.config.credentials = profile;
  }

  const codeDeploy = new aws.CodeDeploy({
    customUserAgent: "aws-actions/aws-codedeploy-run-build",
    region: "eu-west-3",
  });

  const autoScaling = new aws.AutoScaling({
    customUserAgent: "aws-actions/aws-codedeploy-run-build",
    region: "eu-west-3",
  });

  assert(
    codeDeploy.config.credentials,
    "No credentials. Try adding @aws-actions/configure-aws-credentials earlier in your job to set up AWS credentials."
  );

  return { codeDeploy, autoScaling };
}

function logName(Arn) {
  const [logGroupName, logStreamName] = Arn.split(":log-group:")
    .pop()
    .split(":log-stream:");
  if (logGroupName === "null" || logStreamName === "null")
    return {
      logGroupName: undefined,
      logStreamName: undefined,
    };
  return { logGroupName, logStreamName };
}
