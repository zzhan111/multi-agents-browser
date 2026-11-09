1. The Windows tray scripts are UTF-8 with BOM and LF line endings; edit them with encoding utf-8-sig to keep the BOM.

2. A foreground check run from a terminal sees the terminal as foreground; give check-windows-tray.ps1 -DelaySeconds to sample after the tray click.

3. gh pr create puts the Claude Code attribution last, so move it above the required 'Part of ...#33' line afterwards with gh pr edit --body-file.
