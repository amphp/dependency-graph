<?php declare(strict_types=1);

$tmpFile = sys_get_temp_dir() . '/deptrac-amp.json';

exec(
    'vendor/bin/deptrac analyse --formatter=json --output=' . escapeshellarg($tmpFile) . ' --report-uncovered --no-progress 2>/dev/null',
    result_code: $exitCode,
);

if (!file_exists($tmpFile)) {
    fwrite(STDERR, "deptrac did not produce output\n");
    exit(1);
}

$data = json_decode(file_get_contents($tmpFile), true);
unlink($tmpFile);

$ignoredClasses = array_flip(json_decode(file_get_contents(__DIR__ . '/ignored-classes.json'), true));
$validClasses = array_flip(array_keys(json_decode(file_get_contents(__DIR__ . '/data/classes.json'), true)));

$edges = [];
$seen = [];

foreach ($data['files'] as $fileData) {
    foreach ($fileData['messages'] as $msg) {
        // Match both violation ("must not depend on") and uncovered ("has uncovered dependency on")
        if (!preg_match('/^(Amp\\\\.+) (?:must not depend on|has uncovered dependency on) (Amp\\\\.+) \(/', $msg['message'], $m)) {
            continue;
        }
        if (!isset($validClasses[$m[1]]) || !isset($validClasses[$m[2]])
            || isset($ignoredClasses[$m[1]]) || isset($ignoredClasses[$m[2]])) {
            continue;
        }
        $key = $m[1] . '|' . $m[2];
        if (!isset($seen[$key])) {
            $seen[$key] = true;
            $edges[] = ['from' => $m[1], 'to' => $m[2]];
        }
    }
}

file_put_contents(__DIR__ . '/data/dependencies.json', json_encode($edges, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n");

// Trim classes.json to only classes that appear in the dependency graph
$usedClasses = [];
foreach ($edges as ['from' => $from, 'to' => $to]) {
    $usedClasses[$from] = true;
    $usedClasses[$to] = true;
}
$classes = json_decode(file_get_contents(__DIR__ . '/data/classes.json'), true);
$filtered = array_intersect_key($classes, $usedClasses);
ksort($filtered);
file_put_contents(__DIR__ . '/data/classes.json', json_encode($filtered, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n");

echo "Generated data/dependencies.json with " . count($edges) . " edges.\n";
echo "Trimmed data/classes.json to " . count($filtered) . " classes (was " . count($classes) . ").\n";
