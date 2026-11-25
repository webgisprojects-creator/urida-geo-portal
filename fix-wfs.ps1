$p='G:\urida-geo-portal\client\src\components\MapContainer.jsx'
$lines=[System.Collections.Generic.List[string]]([IO.File]::ReadAllLines($p))
# 1) guard line: find '.then((data) => {' after 'const fetchWfsLayerData'
$fn=-1
for($i=0;$i -lt $lines.Count;$i++){ if($lines[$i] -match 'const fetchWfsLayerData'){$fn=$i;break} }
$then=-1
for($i=$fn;$i -lt $fn+120;$i++){ if($lines[$i] -match '^\s*\.then\(\(data\) => \{'){$then=$i;break} }
Write-Output ("fn="+$fn+" then="+$then)
if($lines[$then+1] -match 'if \(abortSignal\?\.aborted\) return;'){
  $lines[$then+1] = '        // Guard covers the outer link of a CQL fallback retry: the inner'
  $lines.Insert($then+2, '        // doFetch(false) already applied features and resolves undefined.')
  $lines.Insert($then+3, '        if (abortSignal?.aborted || !data) return;')
} else { Write-Output 'GUARD ANCHOR MISS'; exit 1 }
# 2) find the '  };' closing fetchWfsLayerData: the '});' + '  };' before 'const applyOsmAmenityData'
$app=-1
for($i=$then;$i -lt $then+40;$i++){ if($lines[$i] -match 'const applyOsmAmenityData'){$app=$i;break} }
$close=-1
for($i=$app-1;$i -gt $app-6;$i--){ if($lines[$i] -match '^\s*\};\s*$'){ $close=$i; break } }
Write-Output ("app="+$app+" close="+$close+" line="+$lines[$close])
if($lines[$close-1] -match '^\s*\}\);\s*$'){
  $lines.Insert($close, '    doFetch(true);')
} else { Write-Output 'CLOSE ANCHOR MISS'; exit 1 }
[IO.File]::WriteAllLines($p, $lines)
Write-Output 'DONE'
