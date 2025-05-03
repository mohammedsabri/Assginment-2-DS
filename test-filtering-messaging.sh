#!/bin/bash

# Replace these with your actual values
BUCKET_NAME="photogallerystack-photobucket465738b3-pwczfhiqlezq"
TOPIC_ARN="arn:aws:sns:eu-west-1:863913536814:PhotoGalleryStack-ImageTopicBD97921B-15Noe7wFaZXU"
TABLE_NAME="PhotoGalleryStack-ImageTableF6499A4E-1G7UDZXB5HUBL"

echo "===== PHOTO GALLERY APP - FILTERING AND MESSAGING TEST ====="

# Create test image
echo "Creating a test JPEG image..."
convert -size 100x100 xc:white test-image.jpeg

# Create test text file (invalid)
echo "Creating an invalid test file..."
echo "This is an invalid file" > test-document.txt

# Create metadata messages
echo '{
  "id": "test-image.jpeg",
  "value": "Test caption for filtering test"
}' > caption-message.json

echo '{
  "metadata_type": {
    "DataType": "String",
    "StringValue": "Caption"
  }
}' > caption-attr.json

echo '{
  "id": "test-image.jpeg",
  "value": "Test Photographer"
}' > name-message.json

echo '{
  "metadata_type": {
    "DataType": "String",
    "StringValue": "name"
  }
}' > name-attr.json

# Create status update message
echo '{
  "id": "test-image.jpeg",
  "date": "03/05/2025",
  "update": {
    "status": "Pass",
    "reason": "Testing filtering and messaging"
  }
}' > status-message.json

echo '{
  "message_type": {
    "DataType": "String",
    "StringValue": "StatusUpdate"
  }
}' > status-attr.json

# Test 1: Upload valid image
echo "===== TEST 1: UPLOADING VALID IMAGE ====="
aws s3 cp test-image.jpeg s3://$BUCKET_NAME/
echo "Waiting for processing..."
sleep 5

# Verify image was processed correctly
aws dynamodb get-item --table-name $TABLE_NAME --key '{"id":{"S":"test-image.jpeg"}}' --query 'Item'
echo ""

# Test 2: Upload invalid file
echo "===== TEST 2: UPLOADING INVALID FILE (SHOULD GO TO DLQ) ====="
aws s3 cp test-document.txt s3://$BUCKET_NAME/
echo "Waiting for processing..."
sleep 10

# Check if invalid file was removed
echo "Checking if invalid file was removed from S3..."
OUTPUT=$(aws s3 ls s3://$BUCKET_NAME/test-document.txt 2>&1)
if [[ $OUTPUT == *"NoSuchKey"* ]] || [[ -z $OUTPUT ]]; then
  echo "✅ File removed successfully (filtering worked)"
else
  echo "❌ File still exists (filtering failed)"
fi
echo ""

# Test 3: Add Caption Metadata
echo "===== TEST 3: ADDING CAPTION METADATA ====="
aws sns publish --topic-arn $TOPIC_ARN --message-attributes file://caption-attr.json --message file://caption-message.json
echo "Waiting for processing..."
sleep 5

# Verify caption was added
CAPTION=$(aws dynamodb get-item --table-name $TABLE_NAME --key '{"id":{"S":"test-image.jpeg"}}' --query 'Item.caption.S' --output text)
echo "Caption: $CAPTION"
if [[ $CAPTION == "Test caption for filtering test" ]]; then
  echo "✅ Caption metadata filter worked"
else
  echo "❌ Caption metadata filter failed"
fi
echo ""

# Test 4: Add Name Metadata
echo "===== TEST 4: ADDING PHOTOGRAPHER NAME ====="
aws sns publish --topic-arn $TOPIC_ARN --message-attributes file://name-attr.json --message file://name-message.json
echo "Waiting for processing..."
sleep 5

# Verify name was added
NAME=$(aws dynamodb get-item --table-name $TABLE_NAME --key '{"id":{"S":"test-image.jpeg"}}' --query 'Item.name.S' --output text)
echo "Photographer Name: $NAME"
if [[ $NAME == "Test Photographer" ]]; then
  echo "✅ Name metadata filter worked"
else
  echo "❌ Name metadata filter failed"
fi
echo ""

# Test 5: Update Status
echo "===== TEST 5: UPDATING IMAGE STATUS ====="
aws sns publish --topic-arn $TOPIC_ARN --message-attributes file://status-attr.json --message file://status-message.json
echo "Waiting for processing..."
sleep 5

# Verify status was updated
STATUS=$(aws dynamodb get-item --table-name $TABLE_NAME --key '{"id":{"S":"test-image.jpeg"}}' --query 'Item.status.S' --output text)
REASON=$(aws dynamodb get-item --table-name $TABLE_NAME --key '{"id":{"S":"test-image.jpeg"}}' --query 'Item.reason.S' --output text)
echo "Status: $STATUS"
echo "Reason: $REASON"
if [[ $STATUS == "Pass" ]]; then
  echo "✅ Status update filter worked"
else
  echo "❌ Status update filter failed"
fi
echo ""

echo "===== TEST SUMMARY ====="
echo "Check CloudWatch logs for detailed execution information:"
echo "LogImageFunction: aws logs filter-log-events --log-group-name /aws/lambda/PhotoGalleryStack-LogImageFunction"
echo "AddMetadataFunction: aws logs filter-log-events --log-group-name /aws/lambda/PhotoGalleryStack-AddMetadataFunction"
echo "UpdateStatusFunction: aws logs filter-log-events --log-group-name /aws/lambda/PhotoGalleryStack-UpdateStatusFunction"
echo "RemoveImageFunction: aws logs filter-log-events --log-group-name /aws/lambda/PhotoGalleryStack-RemoveImageFunction"
echo "ConfirmationMailerFunction: aws logs filter-log-events --log-group-name /aws/lambda/PhotoGalleryStack-ConfirmationMailerFunction"

# Cleanup
rm -f test-image.jpeg test-document.txt caption-message.json caption-attr.json name-message.json name-attr.json status-message.json status-attr.json
