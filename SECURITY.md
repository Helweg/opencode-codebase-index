# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainers directly or use GitHub's private vulnerability reporting
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Security Considerations

This plugin:
- Stores vector indices locally in your project directory
- Sends code chunks to embedding APIs (GitHub Copilot, OpenAI, Google, or local Ollama)
- Does not transmit data to any other third parties

### Data Privacy

- All index data is stored locally
- Code is only sent to your configured embedding provider
- No telemetry or analytics are collected
