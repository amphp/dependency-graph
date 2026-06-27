<?php declare(strict_types=1);

/**
 * Generates deptrac.yaml by scanning PSR-4 namespaces that match a given prefix.
 *
 * Usage: php generate-deptrac.php [namespace-prefix]
 * Example: php generate-deptrac.php Amp\\
 */

$namespacePrefix = $argv[1] ?? 'Amp\\';

require __DIR__ . '/vendor/autoload.php';

function classLikeExists(string $fqcn): bool {
    try {
        return class_exists($fqcn, true) || interface_exists($fqcn, true) || trait_exists($fqcn, true) || enum_exists($fqcn, true);
    } catch (\Throwable) {
        return false;
    }
}

$ignoredClasses = array_flip(json_decode(file_get_contents(__DIR__ . '/ignored-classes.json'), true));

$psr4 = require __DIR__ . '/vendor/composer/autoload_psr4.php';

$classes = [];

foreach ($psr4 as $namespace => $dirs) {
    if (!str_starts_with($namespace, $namespacePrefix)) {
        continue;
    }

    foreach ($dirs as $dir) {
        foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir)) as $file) {
            if ($file->getExtension() !== 'php') {
                continue;
            }

            $tokens = PhpToken::tokenize(file_get_contents($file->getPathname()));
            $currentNamespace = '';

            for ($i = 0; $i < count($tokens); $i++) {
                if ($tokens[$i]->is(T_NAMESPACE)) {
                    $currentNamespace = '';
                    $i++;
                    while (isset($tokens[$i]) && !$tokens[$i]->is(';')) {
                        if ($tokens[$i]->is([T_NAME_QUALIFIED, T_STRING])) {
                            $currentNamespace .= $tokens[$i]->text;
                        }
                        $i++;
                    }
                } elseif ($tokens[$i]->is([T_CLASS, T_INTERFACE, T_TRAIT, T_ENUM])) {
                    // Skip anonymous classes
                    $j = $i + 1;
                    while (isset($tokens[$j]) && $tokens[$j]->is(T_WHITESPACE)) {
                        $j++;
                    }
                    if (isset($tokens[$j]) && $tokens[$j]->is(T_STRING)) {
                        $fqcn = $currentNamespace . '\\' . $tokens[$j]->text;
                        if (classLikeExists($fqcn) && !isset($ignoredClasses[$fqcn])) {
                            $classes[] = $fqcn;
                        }
                    }
                }
            }
        }
    }
}

sort($classes);

$layers = '';
foreach ($classes as $class) {
    $escaped = str_replace('\\', '\\\\', $class);
    $layers .= "    - name: '{$class}'\n";
    $layers .= "      collectors:\n";
    $layers .= "        - type: classNameRegex\n";
    $layers .= "          value: '#^{$escaped}\$#'\n";
}

$yaml = <<<YAML
deptrac:
  paths:
    - vendor
  layers:
{$layers}  ruleset: {}
YAML;

file_put_contents(__DIR__ . '/deptrac.yaml', $yaml);
echo "Generated deptrac.yaml with " . count($classes) . " layers.\n";
