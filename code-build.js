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
  const sdk = buildSdk();

  // Get input options for startBuild
  const inputs = githubInputs();
  const params = inputs2Parameters(inputs);

  console.log("Deployment type is", inputs.deploymentType);

  if (inputs.deploymentType === "in-place") {
    return deploy(sdk, params);
  } else {
    console.log("Looking for ASG");
    const autoscalingGroup = await getAutoScalingGroup();

    console.log("ASG found, scaling up");
    const instanceId = await scale("UP", autoscalingGroup);

    console.log("Waiting for instance to be ready");
    await waitFor(instanceId);
    console.log("Instance is", instanceId);

    // Deregister instance from targetGroup
    //console.log("Deregister instance from TargetGroup");
    //await targetRegistration("deregister", instanceId);

    // Add tag to deploy to this new instance
    console.log("Adding " + NEW_INSTANCE_TAG + " tag to instance");
    await updateTags(instanceId, "target");

    // Update deployment group to reset EC2 tags filter because after
    // each deployment it's changed to NEW_INSTANCE_TAG
    // But it should be kept as it is
    console.log("Updating deployment group");
    await updateDeploymentGroup(sdk);

    console.log("Starting deployment with params", params);
    const deployInfos = await deploy(sdk, params);

    // Register instance from targetGroup
    //console.log("Register instance to TargetGroup");
    //await targetRegistration("register", instanceId);

    // Deploy successful now remove tag from ec2Instance
    console.log("Updating tags");
    await updateTags(instanceId);

    // Scaling down
    console.log("Scaling down");
    await scale("DOWN", autoscalingGroup);

    return deployInfos;
  }
}

async function updateDeploymentGroup(sdk) {
  await sdk.codeDeploy
    .updateDeploymentGroup({
      applicationName: "InTeach-Academy",
      currentDeploymentGroupName: "Production-BlueGreen",
      ec2TagFilters: [
        {
          Key: DEPLOYED_INSTANCE_TAG,
          Value: "",
          Type: "KEY_ONLY",
        },
      ],
    })
    .promise();
}

async function targetRegistration(type, InstanceId) {
  const elb = new aws.ELBv2({ region: "eu-west-3" });

  const { TargetGroups } = await elb.describeTargetGroups().promise();

  const targetGroup = TargetGroups.find(({ TargetGroupName }) =>
    TargetGroupName.toLowerCase().includes("inteach")
  );

  if (!targetGroup) throw new Error("No target group found");

  if (type === "deregister") {
    const TIMEOUT = 300;
    const INTERVAL_TIME = 10 * 1000;
    let totalTime = 0;

    // Wait for target to be healty before unregister
    await new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        if (totalTime / 1000 > TIMEOUT) {
          clearInterval(interval);
          return reject();
        }

        const {
          TargetHealthDescriptions: [
            {
              TargetHealth: { State },
            },
          ],
        } = await elb
          .describeTargetHealth({
            TargetGroupArn: [targetGroup.TargetGroupArn],
            Targets: [{ Id: InstanceId }],
          })
          .promise();

        // Wait for target to be healty before unregister
        if (State === "healthy") {
          clearInterval(interval);
          return resolve();
        }

        totalTime += INTERVAL_TIME;
      }, INTERVAL_TIME);
    });

    // Remove target to avoid interruption time
    return await elb
      .deregisterTargets({
        TargetGroupArn: targetGroup.TargetGroupArn,
        Targets: [
          {
            Id: InstanceId,
          },
        ],
      })
      .promise();
  }

  return await elb
    .registerTargets({
      TargetGroupArn: targetGroup.TargetGroupArn,
      Targets: [
        {
          Id: InstanceId,
        },
      ],
    })
    .promise();
}

async function getAutoScalingGroup() {
  const autoscaling = new aws.AutoScaling({ region: "eu-west-3" });

  const {
    AutoScalingGroups,
  } = await autoscaling.describeAutoScalingGroups().promise();

  const autoscalingGroup = AutoScalingGroups.find((group) =>
    group.AutoScalingGroupName.toLowerCase().includes("academy")
  );

  if (!autoscalingGroup) throw new Error("Autoscaling group not found");

  return autoscalingGroup;
}

async function scale(direction, autoscalingGroup) {
  const ec2 = new aws.EC2({ region: "eu-west-3" });
  const autoscaling = new aws.AutoScaling({ region: "eu-west-3" });

  const DesiredCapacity = direction === "UP" ? 2 : 1;

  await autoscaling
    .updateAutoScalingGroup({
      DesiredCapacity,
      AutoScalingGroupName: autoscalingGroup.AutoScalingGroupName,
    })
    .promise();

  if (direction === "DOWN") return;

  console.log(
    "ASG scaled up, waiting 45 seconds before looking for instances status"
  );

  // Wait 15 seconds before looking for an initializing instance
  await new Promise((resolve) => {
    setTimeout(resolve, 45 * 1000);
  });

  const { InstanceStatuses } = await ec2.describeInstanceStatus().promise();

  const initializingInstance = InstanceStatuses.find(({ InstanceStatus }) => {
    return InstanceStatus.Details.find(({ Status }) => {
      return Status === "initializing";
    });
  });

  if (!initializingInstance) throw new Error("No instance initiliazed found");

  return initializingInstance.InstanceId;
}

async function updateTags(InstanceId, typeOfTag) {
  const ec2 = new aws.EC2({ region: "eu-west-3" });

  if (typeOfTag === "target") {
    await ec2
      .createTags({
        Resources: [InstanceId],
        Tags: [{ Key: NEW_INSTANCE_TAG, Value: "" }],
      })
      .promise();
  } else {
    await Promise.all([
      ec2
        .deleteTags({
          Resources: [InstanceId],
          Tags: [
            {
              Key: NEW_INSTANCE_TAG,
            },
          ],
        })
        .promise(),
      ec2
        .createTags({
          Resources: [InstanceId],
          Tags: [{ Key: DEPLOYED_INSTANCE_TAG, Value: "" }],
        })
        .promise(),
    ]);
  }
}

async function waitFor(InstanceId) {
  const ec2 = new aws.EC2({ region: "eu-west-3" });

  const TIMEOUT = 300;
  const INTERVAL_TIME = 10 * 1000;
  let totalTime = 0;

  await new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      if (totalTime / 1000 > TIMEOUT) {
        clearInterval(interval);
        return reject();
      }

      const status = await ec2
        .describeInstanceStatus({
          InstanceIds: [InstanceId],
        })
        .promise();

      const InstanceStatus =
        status.InstanceStatuses[0] &&
        status.InstanceStatuses[0].InstanceStatus &&
        status.InstanceStatuses[0].InstanceStatus.Status;

      if (InstanceStatus === "ok") {
        clearInterval(interval);
        return resolve();
      }

      totalTime += INTERVAL_TIME;
    }, INTERVAL_TIME);
  });
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

  console.log("deploymentStatus", deploymentStatus);

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
  const deploymentType = core.getInput("deployment-type");

  return {
    applicationName,
    deploymentConfigName,
    deploymentGroupName,
    fileExistsBehavior,
    s3Bucket,
    s3Key,
    bundleType,
    deploymentType,
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
    deploymentType,
  } = inputs;

  const mainConfig = {
    applicationName,
    autoRollbackConfiguration: {
      enabled: true,
      events: ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_REQUEST"],
    },
    deploymentConfigName,
    fileExistsBehavior,
    deploymentGroupName,
    revision: {
      revisionType: "S3",
      s3Location: {
        bucket: s3Bucket,
        bundleType,
        key: s3Key,
      },
    },
  };

  if (deploymentType === "blue-green") {
    return {
      ...mainConfig,
      targetInstances: {
        ec2TagSet: {
          ec2TagSetList: [
            [
              {
                Key: NEW_INSTANCE_TAG,
                Value: "",
                Type: "KEY_ONLY",
              },
            ],
          ],
        },
      },
    };
  }

  return mainConfig;
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
