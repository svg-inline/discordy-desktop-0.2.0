Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DiscordyKeyboard {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@

$VK_V = 0x56
$VK_M = 0x4D
$VK_SHIFT = 0x10
$VK_CONTROL = 0x11
$VK_MENU = 0x12
$VK_LWIN = 0x5B
$VK_RWIN = 0x5C

$prevV = $false
$prevM = $false

function Is-KeyDown([int]$key) {
    return (([DiscordyKeyboard]::GetAsyncKeyState($key) -band 0x8000) -ne 0)
}

while ($true) {
    $modifier = (Is-KeyDown $VK_SHIFT) -or (Is-KeyDown $VK_CONTROL) -or (Is-KeyDown $VK_MENU) -or (Is-KeyDown $VK_LWIN) -or (Is-KeyDown $VK_RWIN)
    $v = (Is-KeyDown $VK_V) -and (-not $modifier)
    $m = (Is-KeyDown $VK_M) -and (-not $modifier)

    if ($v -ne $prevV) {
        if ($v) { [Console]::Out.WriteLine('PTT_DOWN') } else { [Console]::Out.WriteLine('PTT_UP') }
        [Console]::Out.Flush()
        $prevV = $v
    }

    if ($m -ne $prevM) {
        if ($m) { [Console]::Out.WriteLine('PTM_DOWN') } else { [Console]::Out.WriteLine('PTM_UP') }
        [Console]::Out.Flush()
        $prevM = $m
    }

    Start-Sleep -Milliseconds 18
}
