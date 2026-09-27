# Installs and starts Sugabots with Docker, in a `sugabots` folder in the
# current directory. In PowerShell:
#
#   irm https://sugabots.ai/install.ps1 | iex
#
# Safe to run again: an existing compose.yml and .env are kept, so the keys that
# sign people in and encrypt saved API keys never change under an installation.
#
# Errors are thrown rather than exiting, because `exit` in a script run by
# `iex` closes the reader's PowerShell window.

& {
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"

	$composeUrl = "https://sugabots.ai/compose.yml"
	$installDir = "sugabots"
	$appUrl = "http://localhost:3000"
	$healthUrl = "$appUrl/api/health"
	# How long to wait for the first start, which downloads images and migrates the database.
	$startupTimeoutSeconds = 120

	# 32 random bytes, base64-encoded, as `openssl rand -base64 32` prints them.
	function New-RandomKey {
		$bytes = New-Object byte[] 32
		[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
		[Convert]::ToBase64String($bytes)
	}

	if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
		throw "Docker is required. Install Docker Desktop from https://docs.docker.com/get-docker/"
	}
	# Windows PowerShell 5.1 turns a redirected native command's stderr into a terminating error; the exit code says enough.
	try { docker compose version *> $null } catch {}
	if ($LASTEXITCODE -ne 0) {
		throw "Docker Compose is required. It comes with Docker Desktop: https://docs.docker.com/get-docker/"
	}

	New-Item -ItemType Directory -Force -Path $installDir | Out-Null
	Push-Location $installDir
	try {
		if (Test-Path compose.yml) {
			Write-Host "Keeping the existing $installDir\compose.yml"
		} else {
			Invoke-WebRequest -UseBasicParsing -Uri $composeUrl -OutFile compose.yml
		}

		if (Test-Path .env) {
			Write-Host "Keeping the existing keys in $installDir\.env"
		} else {
			$envFile = "BETTER_AUTH_SECRET=$(New-RandomKey)`nCREDENTIALS_ENCRYPTION_KEY=$(New-RandomKey)`n"
			# Without a byte-order mark, which Windows PowerShell's own encoders add and Compose reads as part of the first name.
			[System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $envFile, (New-Object System.Text.UTF8Encoding $false))
			Write-Host "Wrote new keys to $installDir\.env. Back it up and keep it private."
		}

		docker compose up -d
		if ($LASTEXITCODE -ne 0) {
			throw "Docker Compose couldn't start Sugabots. Is Docker Desktop running?"
		}

		Write-Host -NoNewline "Waiting for Sugabots to start"
		$deadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
		while ($true) {
			try {
				Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5 | Out-Null
				break
			} catch {
				if ((Get-Date) -ge $deadline) {
					Write-Host ""
					throw "Sugabots didn't start in time. See what it printed with: cd $installDir; docker compose logs sugabots"
				}
				Write-Host -NoNewline "."
				Start-Sleep -Seconds 2
			}
		}
		Write-Host ""

		Write-Host "Sugabots is running at $appUrl"
		Write-Host "Open it and create your account. Emails, such as your verification link, are in: cd $installDir; docker compose logs sugabots"
	} finally {
		Pop-Location
	}
}
