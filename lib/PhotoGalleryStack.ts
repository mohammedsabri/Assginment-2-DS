
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs_event_source from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class PhotoGalleryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket for storing photos
    const photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Enable DynamoDB streams for the image table
    const imageTable = new dynamodb.Table(this, 'ImageTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES, // Enable streams
    });

    // SNS Topic for messaging
    const imageTopic = new sns.Topic(this, 'ImageTopic');

    // SQS Queue for processing valid images
    const imageQueue = new sqs.Queue(this, 'ImageQueue');

    // Dead Letter Queue (DLQ) for invalid images
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
    });

    // Configure the main queue to use the DLQ
    const validImageQueue = new sqs.Queue(this, 'ValidImageQueue', {
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // Lambda function to log new images
    const logImageFunction = new lambda.Function(this, 'LogImageFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'log-image.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        TABLE_NAME: imageTable.tableName,
        VALID_EXTENSIONS: '.jpeg,.png',
      },
    });

    // Lambda function to add metadata
    const addMetadataFunction = new lambda.Function(this, 'AddMetadataFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'add-metadata.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        TABLE_NAME: imageTable.tableName,
      },
    });

    // Lambda function to update status
    const updateStatusFunction = new lambda.Function(this, 'UpdateStatusFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'update-status.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        TABLE_NAME: imageTable.tableName,
      },
    });

    // Lambda function to send confirmation emails
    const confirmationMailerFunction = new lambda.Function(this, 'ConfirmationMailerFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'confirmation-mailer.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        TABLE_NAME: imageTable.tableName,
      },
    });

    // Lambda function to remove invalid images
    const removeImageFunction = new lambda.Function(this, 'RemoveImageFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'remove-image.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        BUCKET_NAME: photoBucket.bucketName,
      },
    });

    // Grant permissions
    imageTable.grantReadWriteData(logImageFunction);
    imageTable.grantReadWriteData(addMetadataFunction);
    imageTable.grantReadWriteData(updateStatusFunction);
    imageTable.grantReadData(confirmationMailerFunction);
    imageTable.grantStreamRead(confirmationMailerFunction); // Now this is after confirmationMailerFunction is defined
    photoBucket.grantReadWrite(logImageFunction);
    photoBucket.grantDelete(removeImageFunction);

    // Set up S3 notification to trigger Lambda when new objects are created
    photoBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(imageTopic)
    );

    // Subscribe Lambda functions to SNS topic with appropriate filters
    
    // Log Image Lambda - Subscribes to S3 object creation events
    imageTopic.addSubscription(
      new sns_subscriptions.SqsSubscription(validImageQueue, {
        filterPolicy: {
          // Filter for S3 object creation events
          'eventName': sns.SubscriptionFilter.stringFilter({
            allowlist: ['ObjectCreated:Put', 'ObjectCreated:Post', 'ObjectCreated:CompleteMultipartUpload']
          })
        }
      })
    );
    
    // Add Metadata Lambda - Subscribes to metadata update messages
    imageTopic.addSubscription(
      new sns_subscriptions.LambdaSubscription(addMetadataFunction, {
        filterPolicy: {
          'metadata_type': sns.SubscriptionFilter.stringFilter({
            allowlist: ['Caption', 'Date', 'name']
          })
        }
      })
    );
    
    // Update Status Lambda - Subscribes to status update messages
    imageTopic.addSubscription(
      new sns_subscriptions.LambdaSubscription(updateStatusFunction, {
        filterPolicy: {
          // Custom attribute to identify status update messages
          'message_type': sns.SubscriptionFilter.stringFilter({
            allowlist: ['StatusUpdate']
          })
        }
      })
    );

    // Add SQS queue as event source for Log Image Lambda
    logImageFunction.addEventSource(
      new sqs_event_source.SqsEventSource(validImageQueue)
    );

    // Add DLQ as event source for Remove Image Lambda
    removeImageFunction.addEventSource(
      new sqs_event_source.SqsEventSource(deadLetterQueue)
    );

    // Set up DynamoDB stream to trigger confirmation mailer when status changes
    const streamEventSource = new lambda.EventSourceMapping(this, 'StreamEventSource', {
      target: confirmationMailerFunction,
      eventSourceArn: imageTable.tableStreamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 1,
      enabled: true,
    });

    // Add permission for confirmation mailer to send emails
    confirmationMailerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: photoBucket.bucketName,
      description: 'Name of the S3 bucket',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: imageTopic.topicArn,
      description: 'ARN of the SNS topic',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: imageTable.tableName,
      description: 'Name of the DynamoDB table',
    });
  }
}
