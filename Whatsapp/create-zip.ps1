$src = "d:\AI\whatsapp"
$dest = "d:\AI\whatsapp\ApexSender_Portable.zip"

if (Test-Path $dest) {
    Remove-Item $dest -Force
}

$exclude = @("node_modules", "logs", ".git", "ApexSender_Portable.zip")
$items = Get-ChildItem -Path $src | Where-Object { $exclude -notcontains $_.Name }

Write-Host "Creating portable archive: $dest"
Compress-Archive -Path $items.FullName -DestinationPath $dest -CompressionLevel Optimal

$zip = Get-Item $dest
$sizeMb = [math]::Round($zip.Length / 1MB, 2)
Write-Host "SUCCESS! Archive created: $($zip.Name) ($sizeMb MB)"
