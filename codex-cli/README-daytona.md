# Daytona Cloud Sandbox for Codex CLI

This document provides information on how to use the Daytona Cloud Sandbox integration with Codex CLI.

## Overview

The Daytona Cloud Sandbox provides a secure, isolated execution environment for running code and commands in the Codex CLI. This integration allows Codex to execute commands in a secure cloud-based sandbox environment.

## Configuration

### API Key

To use the Daytona Cloud Sandbox, you need a Daytona API key. You can obtain this key from the Daytona platform.

1. Set the `DAYTONA_API_KEY` environment variable with your API key:

```bash
export DAYTONA_API_KEY=your-api-key
```

2. Optionally, you can set the `DAYTONA_API_URL` and `DAYTONA_TARGET` environment variables:

```bash
export DAYTONA_API_URL=https://your-api-url
export DAYTONA_TARGET=us  # Possible values: us, eu
```

### Codex Configuration

You can enable the Daytona sandbox in your Codex configuration file (`~/.codex/config.json` or `~/.codex/config.yaml`):

```json
{
  "model": "your-model",
  "sandboxType": "daytona.cloud"
}
```

Or use the CLI to set it:

```bash
codex config set sandboxType daytona.cloud
```

## Usage

Once configured, Codex will use the Daytona Cloud Sandbox for executing commands and applying patches. The sandbox operation is transparent to the user, with all file paths automatically mapped between local and remote environments.

## Features

- **Isolated Execution**: Commands run in a secure cloud environment, not on your local machine
- **Path Mapping**: Automatically translates between local and remote file paths
- **File Operations**: Handles file uploads, downloads, and patching
- **Automatic Cleanup**: Resources are automatically released when the CLI exits

## Troubleshooting

If you encounter issues with the Daytona Cloud Sandbox:

1. Verify that your `DAYTONA_API_KEY` is correctly set and valid
2. Check your internet connection
3. Enable logging for detailed diagnostics:

```bash
export CODEX_LOG=1
```

## Security

The Daytona Cloud Sandbox provides security through isolation:

- Commands run in isolated cloud containers
- No access to your local machine's resources
- Separate filesystem from host

## Limitations

- Internet connectivity is required
- Some operations may be slower due to network latency
- The sandbox has a default auto-stop interval of 30 minutes