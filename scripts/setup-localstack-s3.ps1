# PowerShell script to set up S3 bucket in LocalStack for testing

Write-Host "Setting up S3 bucket in LocalStack..." -ForegroundColor Cyan

# Create S3 bucket
aws --endpoint-url=http://localhost:4566 s3 mb s3://rabotka-files

# Verify bucket was created
aws --endpoint-url=http://localhost:4566 s3 ls

Write-Host "✅ S3 bucket 'rabotka-files' created successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "You can now test file uploads with LocalStack S3." -ForegroundColor Yellow
