#!/bin/bash

# Script to set up S3 bucket in LocalStack for testing

echo "Setting up S3 bucket in LocalStack..."

# Create S3 bucket
aws --endpoint-url=http://localhost:4566 s3 mb s3://rabotka-files

# Verify bucket was created
aws --endpoint-url=http://localhost:4566 s3 ls

echo "✅ S3 bucket 'rabotka-files' created successfully!"
echo ""
echo "You can now test file uploads with LocalStack S3."
