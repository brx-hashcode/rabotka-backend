# PowerShell script to create the rabotka database if it doesn't exist
# Usage: .\scripts\create-db.ps1

$env:PGPASSWORD = "postgres"
$dbName = "rabotka"
$dbUser = "postgres"
$dbHost = "localhost"
$dbPort = "5432"

Write-Host "Creating database '$dbName' if it doesn't exist..." -ForegroundColor Cyan

$query = @"
SELECT 'CREATE DATABASE $dbName'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$dbName')
"@

psql -h $dbHost -p $dbPort -U $dbUser -d postgres -c $query

Write-Host "Database '$dbName' is ready!" -ForegroundColor Green
