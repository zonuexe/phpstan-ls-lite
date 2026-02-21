<?php

declare(strict_types=1);

use PhpCsFixer\Fixer\Import\GlobalNamespaceImportFixer;
use PhpCsFixer\Fixer\Import\NoUnusedImportsFixer;
use PhpCsFixer\Fixer\Phpdoc\PhpdocLineSpanFixer;
use Symplify\EasyCodingStandard\Config\ECSConfig;
use PhpCsFixer\Fixer\Operator\NotOperatorWithSuccessorSpaceFixer;

return ECSConfig::configure()
    ->withPaths([
        __DIR__ . '/php',
    ])

    // add a single rule
    ->withRules([
        GlobalNamespaceImportFixer::class,
        NoUnusedImportsFixer::class,
    ])
    ->withSkip([
        NotOperatorWithSuccessorSpaceFixer::class,
        PhpdocLineSpanFixer::class,
    ])

    // add sets - group of rules, from easiest to more complex ones
    // uncomment one, apply one, commit, PR, merge and repeat
    ->withPreparedSets(
        spaces: true,
        namespaces: true,
        docblocks: true,
        arrays: true,
        comments: true,
    );
