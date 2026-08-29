param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Run
)

# Prints a JSON blob suitable for appending to canvas RUNS[]
$Run | ConvertTo-Json -Depth 10
