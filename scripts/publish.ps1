# Publish MCP Memory Server to npm
#
# Usage:
#   .\scripts\publish.ps1           # dry-run (preview)
#   .\scripts\publish.ps1 -Execute  # actually publish
#
# Prerequisites:
#   - bun installed
#   - npm logged in (`npm login` or `npm adduser`)
#   - Version bumped in package.json

param(
  [switch]$Execute = $false
)

$PackageJson = Get-Content "$PSScriptRoot\..\package.json" | ConvertFrom-Json
$Name = $PackageJson.name
$Version = $PackageJson.version
$IsPrivate = $PackageJson.private

Write-Output ""
Write-Output "============================================"
Write-Output "  MCP Memory Server — npm publish"
Write-Output "============================================"
Write-Output ""
Write-Output "  Package:    $Name"
Write-Output "  Version:    $Version"
Write-Output "  Private:    $IsPrivate"
Write-Output ""

# 检查 package.json 中的 private 字段
if ($IsPrivate -eq $true -and -not $Execute) {
  Write-Output "  ⚠️  private: true — publish will be BLOCKED by npm."
  Write-Output "     Run with -Execute to temporarily publish anyway,"
  Write-Output "     or remove `"private`: true`" from package.json."
  Write-Output ""
}

# 验证
$Issues = @()

# 检查 bin 文件
if (-not (Test-Path "$PSScriptRoot\..\bin\mcp-memory.js")) {
  $Issues += "bin/mcp-memory.js not found"
}

if ($Issues.Count -gt 0) {
  Write-Output "  ❌ Pre-publish check failed:"
  foreach ($issue in $Issues) {
    Write-Output "     - $issue"
  }
  Write-Output ""
  exit 1
}

# 执行 dry-run
Write-Output "  Running npm pack (dry-run preview)..."
Write-Output ""
Set-Location -LiteralPath "$PSScriptRoot\.."
$PackOutput = npm pack --dry-run 2>&1
Write-Output $PackOutput
Write-Output ""

if ($Execute) {
  Write-Output "  Publishing to npm..."
  Write-Output ""
  npm publish --access public 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Output ""
    Write-Output "  ✅ Published $Name@$Version"
    Write-Output ""
  } else {
    Write-Output ""
    Write-Output "  ❌ Publish failed"
    Write-Output ""
    exit 1
  }
} else {
  Write-Output "  ⚡ Dry-run only. Use -Execute to publish."
  Write-Output ""
  Write-Output "  To change version before publishing:"
  Write-Output "    npm version patch|minor|major"
  Write-Output "    # or manually edit package.json version"
  Write-Output ""
}
