// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const core = require("@actions/core");
const aws = require("aws-sdk");
const assert = require("assert");

const NEW_INSTANCE_TAG = "CODEDEPLOY_TARGET";
const DEPLOYED_INSTANCE_TAG = "ACTIVE_API_INSTANCE";

module.exports = {
  runDeploy,
  deploy,
  waitForBuildEndTime,
  inputs2Parameters,
  githubInputs,
  buildSdk,
  logName,
};

async function runDeploy() {
  // get a codeBuild instance from the SDK
  //const sdk = buildSdk();

  // Create a new EC2 instance from launchTemplate
  const ec2Instance = await createEC2Instance();

  // Attach EC2 instance to AutoScalingGroup
  await attachEC2Instance(ec2Instance);

  // Get input options for startBuild
  //const params = inputs2Parameters(githubInputs());

  //const deployInfos = await deploy(sdk, params);

  // Deploy successful now remove tag from ec2Instance
  await updateTags(ec2Instance);

  return { deploymentId: "ok" };
  //return deployInfos;
}

async function updateTags(ec2Instance) {
  const ec2 = new aws.EC2({ region: "eu-west-3" });

  await Promise.all([
    ec2.deleteTags({
      Resources: [ec2Instance.InstanceId],
      Tags: [
        {
          key: NEW_INSTANCE_TAG,
        },
      ],
    }),
    ec2.createTags({
      Resources: [ec2Instance.InstanceId],
      Tags: [{ Key: DEPLOYED_INSTANCE_TAG }],
    }),
  ]);
}

async function attachEC2Instance(ec2Instance) {
  const autoscaling = new aws.AutoScaling({ region: "eu-west-3" });

  const [
    autoscalingGroup,
  ] = await autoscaling.describeAutoScalingGroups().promise();

  if (!autoscalingGroup) throw new Error("Autoscaling group not found");

  await autoscaling
    .attachInstances({
      InstanceIds: [ec2Instance.InstanceId],
      AutoScalingGroupName: autoscalingGroup.AutoScalingGroupName,
    })
    .promise();
}

async function createEC2Instance() {
  const ec2 = new aws.EC2({ region: "eu-west-3" });

  const instances = await ec2
    .runInstances({
      LaunchTemplate: {
        LaunchTemplateName: "AcademyModel",
        Version: 1,
      },
      TagSpecifications: [
        {
          Tags: [{ Key: NEW_INSTANCE_TAG }],
        },
      ],
      MinCount: 1,
      MaxCount: 1,
    })
    .promise();

  const {
    Instances: [instance],
  } = instances;

  return instance;
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

function inputs2Parameters(inputs) {
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
