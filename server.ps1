# Aura — Daily Planner AI Agent Local Server (Zero Dependencies)
# Serves static web app + disk persistence (/api/state) + local BYOK mock (/v1/chat/completions)
param(
    [int]$Port = 8085
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root "data"
$stateFile = Join-Path $dataDir "planner-state.json"

if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
    $listener.Start()
    Write-Host "Aura Daily Planner running at http://localhost:$Port/"
    Write-Host "Root: $root"
    Write-Host "Press Ctrl+C to stop."
} catch {
    Write-Error "Failed to start HttpListener on port ${Port}: $_"
    exit 1
}

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".ics"  = "text/calendar; charset=utf-8"
}

function Send-JsonResponse($response, [int]$statusCode, [string]$jsonString) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonString)
    $response.ContentType = "application/json; charset=utf-8"
    $response.ContentLength64 = $bytes.Length
    $response.StatusCode = $statusCode
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
}

try {
    while ($listener.IsListening) {
        try {
            $context = $listener.GetContext()
            $request = $context.Request
            $response = $context.Response
            $rawUrl = $request.RawUrl.Split('?')[0]

            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
            $response.AddHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

            if ($request.HttpMethod -eq "OPTIONS") {
                $response.StatusCode = 204
                $response.Close()
                continue
            }

            # Local disk persistence API
            if ($rawUrl -eq "/api/state") {
                if ($request.HttpMethod -eq "GET") {
                    if (Test-Path $stateFile) {
                        $saved = [System.IO.File]::ReadAllText($stateFile, [System.Text.Encoding]::UTF8)
                        Send-JsonResponse $response 200 $saved
                    } else {
                        Send-JsonResponse $response 200 '{"tasks":[],"messages":[]}'
                    }
                    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] 200 GET /api/state"
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                    $body = $reader.ReadToEnd()
                    $reader.Close()
                    # Validate JSON before writing
                    $null = $body | ConvertFrom-Json
                    [System.IO.File]::WriteAllText($stateFile, $body, [System.Text.Encoding]::UTF8)
                    Send-JsonResponse $response 200 '{"ok":true}'
                    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] 200 POST /api/state ($($body.Length) chars)"
                    continue
                }
            }

            # Local OpenAI-compatible mock endpoint for BYOK testing
            if ($rawUrl -eq "/v1/chat/completions" -and $request.HttpMethod -eq "POST") {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $reqBody = $reader.ReadToEnd()
                $reader.Close()

                $agentPayload = @{
                    reply = "Connected to the local mock BYOK endpoint (http://localhost:$Port/v1). I auto-scheduled any unscheduled tasks for today! Replace the Base URL and API Key in Settings with Gemini or OpenAI for full live LLM reasoning."
                    actions = @(
                        @{
                            type = "auto_schedule"
                            includeScheduled = $false
                            strategy = "energy_match"
                        }
                    )
                } | ConvertTo-Json -Depth 5 -Compress

                $completion = @{
                    id = "chatcmpl-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 12)
                    object = "chat.completion"
                    created = [int][double]::Parse((Get-Date -UFormat %s))
                    model = "local-mock-planner"
                    choices = @(
                        @{
                            index = 0
                            message = @{
                                role = "assistant"
                                content = $agentPayload
                            }
                            finish_reason = "stop"
                        }
                    )
                } | ConvertTo-Json -Depth 6

                Send-JsonResponse $response 200 $completion
                Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] 200 POST /v1/chat/completions (mock BYOK)"
                continue
            }

            # Static file serving
            $relPath = if ($rawUrl -eq "/" -or $rawUrl -eq "") { "index.html" } else { $rawUrl.TrimStart('/') }
            $fullPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $relPath))

            if (-not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $response.StatusCode = 403
                $response.Close()
                continue
            }

            if (Test-Path -Path $fullPath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
                $mime = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
                $bytes = [System.IO.File]::ReadAllBytes($fullPath)
                $response.ContentType = $mime
                $response.ContentLength64 = $bytes.Length
                $response.StatusCode = 200
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
                $response.Close()
                Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] 200 GET $rawUrl ($($bytes.Length) bytes)"
            } else {
                $errBytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rawUrl")
                $response.ContentType = "text/plain; charset=utf-8"
                $response.ContentLength64 = $errBytes.Length
                $response.StatusCode = 404
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
                $response.Close()
            }
        } catch {
            Write-Host "Request error: $_"
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
