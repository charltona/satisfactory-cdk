import * as cdk from '@aws-cdk/core';
import {RemovalPolicy} from '@aws-cdk/core';
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import {MountPoint, Protocol} from "@aws-cdk/aws-ecs";
import * as efs from "@aws-cdk/aws-efs";
import * as iam from "@aws-cdk/aws-iam";
import * as logs from "@aws-cdk/aws-logs";
import * as r53 from "@aws-cdk/aws-route53"

export class SatisfactoryCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "SatisfactoryVpc", {
      maxAzs: 2,
      natGateways: 0
    })

    const fileSystem = new efs.FileSystem(this, "FileSystem", {
      vpc,
      removalPolicy: RemovalPolicy.SNAPSHOT
    })

    const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
      fileSystem,
      path: '/satisfactory',
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '0755'
      }
    });

    const efsReadWriteDataPolicy = new iam.Policy(this, 'DataRWPolicy', {
      statements: [
          new iam.PolicyStatement({
            sid: 'AllowReadWriteOnEFS',
            effect: iam.Effect.ALLOW,
            actions: [
              'elasticfilesystem:ClientMount',
              'elasticfilesystem:ClientWrite',
              'elasticfilesystem:DescribeFileSystems',
            ],
            resources: [fileSystem.fileSystemArn],
            conditions: {
              StringEquals: {
                'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
              }
            }
          })
      ]
    })

    const ecsTaskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Satisfactory ECS Task Role',
    })

    efsReadWriteDataPolicy.attachToRole(ecsTaskRole);

    const cluster = new ecs.Cluster(this, "SatisfactoryCluster", {
      clusterName: 'SatisfactoryCDKCluster',
      vpc,
      enableFargateCapacityProviders: true,
    })

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      taskRole: ecsTaskRole,
      cpu: 1024,
      memoryLimitMiB: 5120,
      volumes: [
        {
          name: 'SatisfactoryGameDataVolume',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: accessPoint.accessPointId,
              iam: 'ENABLED'
            }
          }
        }
      ]
    })

    const satisfactoryServerContainer = new ecs.ContainerDefinition(this, 'SatisfactoryContainer', {
      containerName: 'SatisfactoryServer',
      image: ecs.ContainerImage.fromRegistry('wolveix/satisfactory-server'),
      portMappings: [
        {
          containerPort: 7777,
          hostPort: 7777,
          protocol: Protocol.UDP
        },
        {
          containerPort: 15000,
          hostPort: 15000,
          protocol: Protocol.UDP
        },
        {
          containerPort: 15777,
          hostPort: 15777,
          protocol: Protocol.UDP
        },
      ],
      taskDefinition,
      logging: new ecs.AwsLogDriver({
        logRetention: logs.RetentionDays.THREE_DAYS,
        streamPrefix: 'SatisfactoryServer'
      })
    })

    const satisfactoryServerMountPoint: MountPoint = {
      containerPath: '/config',
      sourceVolume: 'SatisfactoryGameDataVolume',
      readOnly: false,
    }

    satisfactoryServerContainer.addMountPoints(satisfactoryServerMountPoint)


    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Security Group for SatisfactoryServerService'
    });

    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(7777))
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(15000))
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(15777))

    const satisfactoryServerService = new ecs.FargateService(this, 'FargateService', {
      cluster,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
          base: 1,
        }
      ],
      taskDefinition,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      serviceName: 'SatisfactoryServerService',
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [serviceSecurityGroup]
    })

    fileSystem.connections.allowDefaultPortFrom(satisfactoryServerService.connections);



    // Autoscaling policy, if active connections === 0 for 30 mins, then set desiredCount to 0.

    // Write lambda function to set desiredCount to 1.
  }
}
