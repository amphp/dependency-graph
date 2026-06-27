<?php declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

function classLikeExists(string $fqcn): bool {
    try {
        return class_exists($fqcn, true) || interface_exists($fqcn, true) || trait_exists($fqcn, true) || enum_exists($fqcn, true);
    } catch (\Throwable) {
        return false;
    }
}

$installed = require __DIR__ . '/vendor/composer/installed.php';
$classMap = [];

foreach ($installed['versions'] as $packageName => $info) {
    $installPath = $info['install_path'] ?? null;
    if (!$installPath || !is_dir($installPath)) {
        continue;
    }

    $pkgComposer = $installPath . '/composer.json';
    if (!file_exists($pkgComposer)) {
        continue;
    }

    $pkgConfig = json_decode(file_get_contents($pkgComposer), true);
    $psr4 = $pkgConfig['autoload']['psr-4'] ?? [];

    foreach ($psr4 as $namespace => $dirs) {
        foreach ((array) $dirs as $dir) {
            $fullDir = realpath($installPath . '/' . $dir);
            if (!$fullDir || !is_dir($fullDir)) {
                continue;
            }

            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($fullDir)) as $file) {
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
                        $j = $i + 1;
                        while (isset($tokens[$j]) && $tokens[$j]->is(T_WHITESPACE)) {
                            $j++;
                        }
                        if (isset($tokens[$j]) && $tokens[$j]->is(T_STRING)) {
                            $fqcn = $currentNamespace . '\\' . $tokens[$j]->text;
                            if (classLikeExists($fqcn)) {
                                $classMap[$fqcn] = $packageName;
                            }
                        }
                    }
                }
            }
        }
    }
}

ksort($classMap);

file_put_contents(__DIR__ . '/data/classes.json', json_encode($classMap, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n");
echo "Generated data/classes.json with " . count($classMap) . " entries.\n";
