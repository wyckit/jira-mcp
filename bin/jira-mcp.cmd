@echo off
rem Resolves a runtime for the Jira MCP server, so one plugin works whether or
rem not Node is available on the machine.
rem
rem Order:
rem   1. JIRA_MCP_EXE            explicit path to the standalone executable
rem   2. <plugin>\jira-mcp.exe   executable dropped into the plugin folder
rem   3. <plugin>\dist\jira-mcp.exe
rem   4. node <plugin>\server.js
rem
rem Nothing may be written to stdout — that stream carries the JSON-RPC
rem protocol. Diagnostics go to stderr only.
setlocal
set "PLUGIN_ROOT=%~dp0.."

if not defined JIRA_MCP_EXE goto :try_plugin_root
if not exist "%JIRA_MCP_EXE%" goto :try_plugin_root
"%JIRA_MCP_EXE%"
exit /b %errorlevel%

:try_plugin_root
if not exist "%PLUGIN_ROOT%\jira-mcp.exe" goto :try_dist
"%PLUGIN_ROOT%\jira-mcp.exe"
exit /b %errorlevel%

:try_dist
if not exist "%PLUGIN_ROOT%\dist\jira-mcp.exe" goto :try_node
"%PLUGIN_ROOT%\dist\jira-mcp.exe"
exit /b %errorlevel%

:try_node
where node >nul 2>&1
if errorlevel 1 goto :no_runtime
node "%PLUGIN_ROOT%\server.js"
exit /b %errorlevel%

:no_runtime
1>&2 echo jira-mcp: no runtime found.
1>&2 echo   Set JIRA_MCP_EXE to the full path of jira-mcp.exe, or place jira-mcp.exe in
1>&2 echo   the plugin folder, or install Node 18 or newer.
exit /b 1
