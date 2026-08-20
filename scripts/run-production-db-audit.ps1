[CmdletBinding()]
param(
    [string]$ProjectRef = "yyqxesnrlgzifydkzkpd"
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDirectory = Join-Path $workspace "scratch\audits\$timestamp"

function Resolve-SupabaseRunner {
    $supabase = Get-Command supabase -ErrorAction SilentlyContinue
    if ($supabase) {
        return @{ Executable = $supabase.Source; Prefix = @() }
    }

    $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if ($npx) {
        return @{ Executable = $npx.Source; Prefix = @("--yes", "supabase") }
    }

    $runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
    $nodeDirectory = Join-Path $runtimeRoot "node\bin"
    $pnpm = Join-Path $runtimeRoot "bin\fallback\pnpm.cmd"
    if ((Test-Path $pnpm) -and (Test-Path (Join-Path $nodeDirectory "node.exe"))) {
        $env:Path = "$nodeDirectory;$env:Path"
        return @{ Executable = $pnpm; Prefix = @("dlx", "supabase") }
    }

    throw "Supabase CLI was not found. Install Node.js and run: npm install -g supabase"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$runner = Resolve-SupabaseRunner
$securePassword = Read-Host "Supabase database password (hidden)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $env:SUPABASE_DB_PASSWORD = $plainPassword

    Write-Host "`nRunning read-only production database checks..." -ForegroundColor Cyan
    $checks = @(
        "db-stats",
        "replication-slots",
        "locks",
        "blocking",
        "outliers",
        "index-stats",
        "long-running-queries",
        "bloat",
        "role-stats",
        "vacuum-stats",
        "table-stats",
        "traffic-profile"
    )

    $failures = @()
    foreach ($check in $checks) {
        $outputFile = Join-Path $outputDirectory "$check.txt"
        Write-Host "- $check" -ForegroundColor DarkCyan
        $commandArguments = @($runner.Prefix) + @("inspect", "db", $check, "--linked")
        & $runner.Executable @commandArguments 2>&1 |
            Tee-Object -FilePath $outputFile
        if ($LASTEXITCODE -ne 0) {
            $failures += $check
        }
    }

    $backupFile = Join-Path $outputDirectory "backup-status.txt"
    $backupArguments = @($runner.Prefix) + @("backups", "list", "--project-ref", $ProjectRef)
    & $runner.Executable @backupArguments 2>&1 |
        Tee-Object -FilePath $backupFile
    if ($LASTEXITCODE -ne 0) {
        $failures += "backup-status"
    }

    Write-Host "`nAudit output: $outputDirectory" -ForegroundColor Green
    if ($failures.Count -gt 0) {
        Write-Warning "Some checks failed: $($failures -join ', ')"
        exit 1
    }

    Write-Host "All read-only checks completed." -ForegroundColor Green
}
finally {
    Remove-Item Env:\SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
