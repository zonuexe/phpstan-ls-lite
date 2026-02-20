<?php

declare(strict_types=1);

const PROTOCOL_VERSION = 1;

/** @var array<string, bool> */
$autoloadLoaded = [];

/** @var array<string, array{provider:object,scope:object,parser:object|null,nodeScopeResolver:object|null,scopeFactory:object|null}> */
$reflectionStateByRoot = [];

function find_project_root(string $filePath): ?string
{
    $dir = is_dir($filePath) ? $filePath : dirname($filePath);
    while (true) {
        $composerJson = $dir . DIRECTORY_SEPARATOR . 'composer.json';
        if (is_file($composerJson)) {
            return $dir;
        }
        $parent = dirname($dir);
        if ($parent === $dir) {
            return null;
        }
        $dir = $parent;
    }
}

function ensure_project_autoload(string $filePath): void
{
    global $autoloadLoaded;
    $root = find_project_root($filePath);
    if ($root === null) {
        return;
    }
    if (isset($autoloadLoaded[$root])) {
        return;
    }
    $autoload = $root . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';
    if (is_file($autoload)) {
        require_once $autoload;
    }
    $phpstanBinAutoload =
        $root
        . DIRECTORY_SEPARATOR
        . 'vendor-bin'
        . DIRECTORY_SEPARATOR
        . 'phpstan'
        . DIRECTORY_SEPARATOR
        . 'vendor'
        . DIRECTORY_SEPARATOR
        . 'autoload.php';
    if (is_file($phpstanBinAutoload)) {
        require_once $phpstanBinAutoload;
    }
    $autoloadLoaded[$root] = true;
}

/**
 * @return ?array{root:string,provider:object,scope:object,parser:object|null,nodeScopeResolver:object|null,scopeFactory:object|null}
 */
function get_phpstan_reflection_state(string $filePath): ?array
{
    global $reflectionStateByRoot;

    $root = find_project_root($filePath);
    if ($root === null) {
        return null;
    }
    if (isset($reflectionStateByRoot[$root])) {
        $state = $reflectionStateByRoot[$root];
        return [
            'root' => $root,
            'provider' => $state['provider'],
            'scope' => $state['scope'],
            'parser' => $state['parser'],
            'nodeScopeResolver' => $state['nodeScopeResolver'],
            'scopeFactory' => $state['scopeFactory'],
        ];
    }

    ensure_project_autoload($filePath);
    if (!class_exists('PHPStan\\DependencyInjection\\ContainerFactory')) {
        return null;
    }
    if (!class_exists('PHPStan\\Analyser\\OutOfClassScope')) {
        return null;
    }

    $phpstanPhar = $root
        . DIRECTORY_SEPARATOR
        . 'vendor'
        . DIRECTORY_SEPARATOR
        . 'phpstan'
        . DIRECTORY_SEPARATOR
        . 'phpstan'
        . DIRECTORY_SEPARATOR
        . 'phpstan.phar';
    if (class_exists('Phar') && is_file($phpstanPhar)) {
        try {
            \Phar::loadPhar($phpstanPhar, 'phpstan.phar');
        } catch (Throwable $e) {
            // Ignore; container creation fallback is handled below.
        }
    }

    $provider = null;
    $scope = null;
    $parser = null;
    $nodeScopeResolver = null;
    $scopeFactory = null;
    $tmpDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'phpstan-ls-lite' . DIRECTORY_SEPARATOR . sha1($root);
    if (!is_dir($tmpDir)) {
        @mkdir($tmpDir, 0777, true);
    }
    $defaultConfig = $root . DIRECTORY_SEPARATOR . 'phpstan.neon';
    $distConfig = $root . DIRECTORY_SEPARATOR . 'phpstan.neon.dist';
    $configCandidates = [[]];
    if (is_file($defaultConfig)) {
        array_unshift($configCandidates, [$defaultConfig]);
    } elseif (is_file($distConfig)) {
        array_unshift($configCandidates, [$distConfig]);
    }

    foreach ($configCandidates as $configFiles) {
        try {
            $factory = new \PHPStan\DependencyInjection\ContainerFactory($root);
            $container = $factory->create(
                $tmpDir,
                $configFiles,
                [],
                [$root],
                [],
                '',
                null,
                null,
                null,
                null,
                null
            );
            $provider = $container->getByType('PHPStan\\Reflection\\ReflectionProvider');
            $scope = new \PHPStan\Analyser\OutOfClassScope();
            if ($container->hasService('currentPhpVersionRichParser')) {
                $parser = $container->getService('currentPhpVersionRichParser');
            } elseif ($container->hasService('currentPhpVersionSimpleParser')) {
                $parser = $container->getService('currentPhpVersionSimpleParser');
            } else {
                $parser = null;
            }
            $nodeScopeResolver = $container->getByType('PHPStan\\Analyser\\NodeScopeResolver');
            $scopeFactory = $container->getByType('PHPStan\\Analyser\\ScopeFactory');
            break;
        } catch (Throwable $e) {
            $provider = null;
            $scope = null;
            $parser = null;
            $nodeScopeResolver = null;
            $scopeFactory = null;
            continue;
        }
    }

    if (!is_object($provider) || !is_object($scope)) {
        return null;
    }

    $reflectionStateByRoot[$root] = [
        'provider' => $provider,
        'scope' => $scope,
        'parser' => is_object($parser) ? $parser : null,
        'nodeScopeResolver' => is_object($nodeScopeResolver) ? $nodeScopeResolver : null,
        'scopeFactory' => is_object($scopeFactory) ? $scopeFactory : null,
    ];

    return [
        'root' => $root,
        'provider' => $provider,
        'scope' => $scope,
        'parser' => is_object($parser) ? $parser : null,
        'nodeScopeResolver' => is_object($nodeScopeResolver) ? $nodeScopeResolver : null,
        'scopeFactory' => is_object($scopeFactory) ? $scopeFactory : null,
    ];
}

/**
 * @return array{namespace:string,useClasses:array<string,string>}
 */
function parse_file_context(string $text): array
{
    $namespace = '';
    if (preg_match('/^\s*namespace\s+([^;]+);/m', $text, $match) === 1) {
        $namespace = trim((string) $match[1]);
    }

    /** @var array<string,string> $useClasses */
    $useClasses = [];
    if (preg_match_all('/^\s*use\s+(?!function\b|const\b)([^;]+);/m', $text, $matches) === 1 || !empty($matches[1])) {
        foreach ($matches[1] as $clauseRaw) {
            $clause = trim((string) $clauseRaw);
            if ($clause === '') {
                continue;
            }
            $alias = null;
            $fullName = $clause;
            if (preg_match('/^(.+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i', $clause, $aliasMatch) === 1) {
                $fullName = trim((string) $aliasMatch[1]);
                $alias = (string) $aliasMatch[2];
            }
            $fullName = ltrim($fullName, '\\');
            if ($fullName === '') {
                continue;
            }
            if ($alias === null) {
                $parts = explode('\\', $fullName);
                $alias = (string) end($parts);
            }
            $useClasses[$alias] = $fullName;
        }
    }

    return [
        'namespace' => $namespace,
        'useClasses' => $useClasses,
    ];
}

/**
 * @param array{namespace:string,useClasses:array<string,string>} $context
 */
function resolve_class_name(string $rawName, array $context): string
{
    if ($rawName === '') {
        return '';
    }
    if ($rawName[0] === '\\') {
        return ltrim($rawName, '\\');
    }

    if (str_contains($rawName, '\\')) {
        if ($context['namespace'] !== '') {
            return $context['namespace'] . '\\' . $rawName;
        }
        return $rawName;
    }

    if (isset($context['useClasses'][$rawName])) {
        return $context['useClasses'][$rawName];
    }
    if ($context['namespace'] !== '') {
        return $context['namespace'] . '\\' . $rawName;
    }
    return $rawName;
}

function create_error_response(string $id, string $code, string $message): array
{
    return [
        'protocolVersion' => PROTOCOL_VERSION,
        'id' => $id,
        'ok' => false,
        'error' => [
            'code' => $code,
            'message' => $message,
        ],
    ];
}

/**
 * @return array{start:int,end:int,text:string}
 */
function trim_segment(string $text, int $start, int $end): array
{
    $segment = substr($text, $start, $end - $start);
    if (!is_string($segment)) {
        return ['start' => $start, 'end' => $start, 'text' => ''];
    }
    $leading = strspn($segment, " \t\n\r\0\x0B");
    $trailing = strlen($segment) - strlen(rtrim($segment));
    $trimmedStart = $start + $leading;
    $trimmedEnd = max($trimmedStart, $end - $trailing);
    $trimmed = substr($text, $trimmedStart, $trimmedEnd - $trimmedStart);
    if (!is_string($trimmed)) {
        $trimmed = '';
    }
    return [
        'start' => $trimmedStart,
        'end' => $trimmedEnd,
        'text' => $trimmed,
    ];
}

/**
 * @return array<int, array{start:int,end:int,text:string}>
 */
function split_top_level_arguments(string $text, int $start, int $end): array
{
    /** @var array<int, array{start:int,end:int,text:string}> $arguments */
    $arguments = [];
    $segmentStart = $start;
    $parenDepth = 0;
    $bracketDepth = 0;
    $braceDepth = 0;
    $quote = null;

    for ($i = $start; $i <= $end; $i++) {
        $atEnd = $i === $end;
        $ch = $atEnd ? ',' : ($text[$i] ?? '');
        $next = $text[$i + 1] ?? '';

        if ($quote !== null) {
            if ($ch === '\\') {
                $i++;
                continue;
            }
            if ($ch === $quote) {
                $quote = null;
            }
            continue;
        }

        if ($ch === '\'' || $ch === '"') {
            $quote = $ch;
            continue;
        }
        if ($ch === '/' && $next === '/') {
            $i += 2;
            while ($i <= $end && ($text[$i] ?? '') !== "\n") {
                $i++;
            }
            continue;
        }
        if ($ch === '#') {
            while ($i <= $end && ($text[$i] ?? '') !== "\n") {
                $i++;
            }
            continue;
        }
        if ($ch === '/' && $next === '*') {
            $i += 2;
            while ($i <= $end) {
                if (($text[$i] ?? '') === '*' && ($text[$i + 1] ?? '') === '/') {
                    $i++;
                    break;
                }
                $i++;
            }
            continue;
        }

        if ($ch === '(') {
            $parenDepth++;
            continue;
        }
        if ($ch === ')') {
            $parenDepth = max(0, $parenDepth - 1);
            continue;
        }
        if ($ch === '[') {
            $bracketDepth++;
            continue;
        }
        if ($ch === ']') {
            $bracketDepth = max(0, $bracketDepth - 1);
            continue;
        }
        if ($ch === '{') {
            $braceDepth++;
            continue;
        }
        if ($ch === '}') {
            $braceDepth = max(0, $braceDepth - 1);
            continue;
        }

        if ($ch === ',' && $parenDepth === 0 && $bracketDepth === 0 && $braceDepth === 0) {
            $arguments[] = trim_segment($text, $segmentStart, $i);
            $segmentStart = $i + 1;
        }
    }

    return array_values(array_filter($arguments, static function (array $arg): bool {
        return $arg['start'] < $arg['end'];
    }));
}

function find_matching_paren(string $text, int $openPos): int
{
    $depth = 1;
    $quote = null;
    $len = strlen($text);
    for ($i = $openPos + 1; $i < $len; $i++) {
        $ch = $text[$i] ?? '';
        $next = $text[$i + 1] ?? '';

        if ($quote !== null) {
            if ($ch === '\\') {
                $i++;
                continue;
            }
            if ($ch === $quote) {
                $quote = null;
            }
            continue;
        }

        if ($ch === '\'' || $ch === '"') {
            $quote = $ch;
            continue;
        }
        if ($ch === '/' && $next === '/') {
            $i += 2;
            while ($i < $len && ($text[$i] ?? '') !== "\n") {
                $i++;
            }
            continue;
        }
        if ($ch === '#') {
            while ($i < $len && ($text[$i] ?? '') !== "\n") {
                $i++;
            }
            continue;
        }
        if ($ch === '/' && $next === '*') {
            $i += 2;
            while ($i < $len) {
                if (($text[$i] ?? '') === '*' && ($text[$i + 1] ?? '') === '/') {
                    $i++;
                    break;
                }
                $i++;
            }
            continue;
        }

        if ($ch === '(') {
            $depth++;
            continue;
        }
        if ($ch === ')') {
            $depth--;
            if ($depth === 0) {
                return $i;
            }
        }
    }

    return -1;
}

/**
 * @return array{word:string,start:int,end:int}|null
 */
function read_identifier_backward(string $text, int $index, string $pattern = '/[A-Za-z0-9_]/'): ?array
{
    $i = $index;
    while ($i >= 0 && ctype_space($text[$i] ?? '')) {
        $i--;
    }
    if ($i < 0) {
        return null;
    }
    $end = $i;
    while ($i >= 0) {
        $ch = $text[$i] ?? '';
        if (preg_match($pattern, $ch) !== 1) {
            break;
        }
        $i--;
    }
    $start = $i + 1;
    if ($start > $end) {
        return null;
    }
    $word = substr($text, $start, $end - $start + 1);
    if (!is_string($word) || $word === '') {
        return null;
    }
    return [
        'word' => $word,
        'start' => $start,
        'end' => $end,
    ];
}

/**
 * @return ?array{kind:string,name:string,className?:string,methodName?:string,receiverVarName?:string}
 */
function extract_callable_from_before_paren(string $text, int $openPos): ?array
{
    $method = read_identifier_backward($text, $openPos - 1);
    if ($method === null) {
        return null;
    }
    $token = $method['word'];

    $keywords = [
        'if', 'for', 'foreach', 'while', 'switch', 'catch', 'match', 'isset', 'empty',
        'echo', 'print', 'unset', 'new', 'array', 'list', 'include', 'include_once',
        'require', 'require_once', 'function',
    ];
    if (in_array(strtolower($token), $keywords, true)) {
        return null;
    }

    $j = $method['start'] - 1;
    while ($j >= 0 && ctype_space($text[$j] ?? '')) {
        $j--;
    }

    $op = '';
    if ($j >= 1 && ($text[$j - 1] ?? '') === ':' && ($text[$j] ?? '') === ':') {
        $op = '::';
    } elseif ($j >= 1 && ($text[$j - 1] ?? '') === '-' && ($text[$j] ?? '') === '>') {
        $op = '->';
    }

    if ($op === '::') {
        $classToken = read_identifier_backward($text, $j - 2, '/[A-Za-z0-9_\\\\]/');
        if ($classToken === null) {
            return null;
        }
        return [
            'kind' => 'static',
            'name' => $classToken['word'] . '::' . $method['word'],
            'className' => $classToken['word'],
            'methodName' => $method['word'],
        ];
    }

    if ($op === '->') {
        $receiver = read_identifier_backward($text, $j - 2, '/[A-Za-z0-9_$]/');
        if ($receiver === null) {
            return null;
        }
        if (!preg_match('/^\$[A-Za-z_][A-Za-z0-9_]*$/', $receiver['word'])) {
            return null;
        }
        return [
            'kind' => 'instance',
            'name' => $receiver['word'] . '->' . $method['word'],
            'receiverVarName' => substr($receiver['word'], 1),
            'methodName' => $method['word'],
        ];
    }

    $before = read_identifier_backward($text, $method['start'] - 1);
    if ($before !== null) {
        $beforeWord = strtolower($before['word']);
        if ($beforeWord === 'function' || $beforeWord === 'fn') {
            return null;
        }
    }

    return [
        'kind' => 'function',
        'name' => $method['word'],
    ];
}

/**
 * @param array{namespace:string,useClasses:array<string,string>} $context
 * @return array<int, array{start:int,end:int,className:string}>
 */
function collect_class_ranges(string $text, array $context): array
{
    $ranges = [];
    if (preg_match_all('/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{/m', $text, $matches, PREG_OFFSET_CAPTURE) !== 1) {
        return $ranges;
    }
    /** @var array<int, array{0:string,1:int}> $classMatches */
    $classMatches = $matches[1] ?? [];
    foreach ($classMatches as $entry) {
        $name = (string) ($entry[0] ?? '');
        $nameOffset = (int) ($entry[1] ?? -1);
        if ($name === '' || $nameOffset < 0) {
            continue;
        }
        $bracePos = strpos($text, '{', $nameOffset + strlen($name));
        if ($bracePos === false) {
            continue;
        }
        $depth = 1;
        $len = strlen($text);
        $end = $bracePos;
        for ($i = $bracePos + 1; $i < $len; $i++) {
            $ch = $text[$i] ?? '';
            if ($ch === '{') {
                $depth++;
                continue;
            }
            if ($ch === '}') {
                $depth--;
                if ($depth === 0) {
                    $end = $i;
                    break;
                }
            }
        }
        $ranges[] = [
            'start' => $bracePos,
            'end' => $end,
            'className' => resolve_class_name($name, $context),
        ];
    }
    return $ranges;
}

/**
 * @param array{namespace:string,useClasses:array<string,string>} $context
 * @return array<int, array{offset:int,varName:string,className:string}>
 */
function collect_variable_type_events(string $text, array $context): array
{
    $events = [];

    if (
        preg_match_all(
            '/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)/m',
            $text,
            $matches,
            PREG_OFFSET_CAPTURE
        ) === 1 || !empty($matches[1])
    ) {
        /** @var array<int, array{0:string,1:int}> $varMatches */
        $varMatches = $matches[1] ?? [];
        /** @var array<int, array{0:string,1:int}> $classMatches */
        $classMatches = $matches[2] ?? [];
        $count = min(count($varMatches), count($classMatches));
        for ($i = 0; $i < $count; $i++) {
            $var = (string) ($varMatches[$i][0] ?? '');
            $varOffset = (int) ($varMatches[$i][1] ?? -1);
            $rawClass = (string) ($classMatches[$i][0] ?? '');
            if ($var === '' || $rawClass === '' || $varOffset < 0) {
                continue;
            }
            $events[] = [
                'offset' => $varOffset,
                'varName' => $var,
                'className' => resolve_class_name($rawClass, $context),
            ];
        }
    }

    if (
        preg_match_all(
            '/@var\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/m',
            $text,
            $matches,
            PREG_OFFSET_CAPTURE
        ) === 1 || !empty($matches[1])
    ) {
        /** @var array<int, array{0:string,1:int}> $classMatches */
        $classMatches = $matches[1] ?? [];
        /** @var array<int, array{0:string,1:int}> $varMatches */
        $varMatches = $matches[2] ?? [];
        $count = min(count($varMatches), count($classMatches));
        for ($i = 0; $i < $count; $i++) {
            $rawClass = (string) ($classMatches[$i][0] ?? '');
            $var = (string) ($varMatches[$i][0] ?? '');
            $offset = (int) ($varMatches[$i][1] ?? -1);
            if ($var === '' || $rawClass === '' || $offset < 0) {
                continue;
            }
            $events[] = [
                'offset' => $offset,
                'varName' => $var,
                'className' => resolve_class_name($rawClass, $context),
            ];
        }
    }

    usort($events, static function (array $a, array $b): int {
        return $a['offset'] <=> $b['offset'];
    });
    return $events;
}

/**
 * @param array<int, array{start:int,end:int,className:string}> $classRanges
 * @param array<int, array{offset:int,varName:string,className:string}> $variableTypeEvents
 */
function infer_instance_receiver_class(
    string $receiverVarName,
    int $callOffset,
    array $classRanges,
    array $variableTypeEvents
): ?string {
    if ($receiverVarName === 'this') {
        foreach ($classRanges as $range) {
            if ($callOffset >= $range['start'] && $callOffset <= $range['end']) {
                return $range['className'];
            }
        }
        return null;
    }

    $matched = null;
    foreach ($variableTypeEvents as $event) {
        if ($event['offset'] > $callOffset) {
            break;
        }
        if ($event['varName'] !== $receiverVarName) {
            continue;
        }
        $matched = $event['className'];
    }
    return $matched;
}

/**
 * @return ?array{markdown:string}
 */
function build_hover_payload_from_scope(
    string $filePath,
    string $text,
    int $cursorOffset,
    ?array $reflectionState
): ?array {
    if (
        $reflectionState === null
        || !isset($reflectionState['parser'], $reflectionState['nodeScopeResolver'], $reflectionState['scopeFactory'])
        || !is_object($reflectionState['parser'])
        || !is_object($reflectionState['nodeScopeResolver'])
        || !is_object($reflectionState['scopeFactory'])
        || !method_exists($reflectionState['parser'], 'parseString')
        || !method_exists($reflectionState['nodeScopeResolver'], 'processNodes')
        || !method_exists($reflectionState['scopeFactory'], 'create')
    ) {
        return null;
    }

    try {
        $stmts = $reflectionState['parser']->parseString($text);
    } catch (Throwable $e) {
        return null;
    }
    if (!is_array($stmts) || !class_exists('PHPStan\\Analyser\\ScopeContext')) {
        return null;
    }

    $scopeContext = \PHPStan\Analyser\ScopeContext::create($filePath);
    $scope = $reflectionState['scopeFactory']->create($scopeContext, null);
    $candidateOffsets = [$cursorOffset];
    if ($cursorOffset > 0) {
        $candidateOffsets[] = $cursorOffset - 1;
    }
    $best = null;

    $reflectionState['nodeScopeResolver']->processNodes(
        $stmts,
        $scope,
        static function (\PhpParser\Node $node, $currentScope) use (&$best, $candidateOffsets, $text): void {
            $start = (int) $node->getStartFilePos();
            $end = (int) $node->getEndFilePos() + 1;
            if ($start < 0 || $end <= $start) {
                return;
            }
            $matched = false;
            foreach ($candidateOffsets as $offset) {
                if ($offset >= $start && $offset < $end) {
                    $matched = true;
                    break;
                }
            }
            if (!$matched) {
                return;
            }
            if (!($node instanceof \PhpParser\Node\Expr)) {
                return;
            }
            try {
                $type = $currentScope->getType($node);
                $typeString = $type->describe(\PHPStan\Type\VerbosityLevel::precise());
            } catch (Throwable $e) {
                return;
            }
            if (!is_string($typeString) || $typeString === '') {
                return;
            }
            $len = $end - $start;
            if ($best !== null && $best['len'] <= $len) {
                return;
            }
            $exprText = substr($text, $start, $len);
            if (!is_string($exprText) || $exprText === '') {
                return;
            }
            $exprText = trim(preg_replace('/\s+/', ' ', $exprText) ?? '');
            if ($exprText === '') {
                return;
            }
            $best = [
                'len' => $len,
                'expr' => $exprText,
                'type' => $typeString,
            ];
        }
    );

    if ($best === null) {
        return null;
    }
    return [
        'markdown' => "```php\n" . $best['expr'] . ': ' . $best['type'] . "\n```",
    ];
}

/**
 * @return ?array{name:string,start:int,end:int}
 */
function find_identifier_at_offset(string $text, int $offset): ?array
{
    $len = strlen($text);
    if ($len === 0) {
        return null;
    }
    $offset = max(0, min($offset, $len - 1));
    $isIdentChar = static function (string $ch): bool {
        return preg_match('/[A-Za-z0-9_\\\\]/', $ch) === 1;
    };

    if (!$isIdentChar($text[$offset] ?? '')) {
        if ($offset > 0 && $isIdentChar($text[$offset - 1] ?? '')) {
            $offset--;
        } else {
            return null;
        }
    }
    $start = $offset;
    while ($start > 0 && $isIdentChar($text[$start - 1] ?? '')) {
        $start--;
    }
    $end = $offset;
    while ($end + 1 < $len && $isIdentChar($text[$end + 1] ?? '')) {
        $end++;
    }
    $token = substr($text, $start, $end - $start + 1);
    if (!is_string($token) || $token === '') {
        return null;
    }
    return [
        'name' => $token,
        'start' => $start,
        'end' => $end + 1,
    ];
}

/**
 * @return ?array{kind:string,name?:string,className?:string,methodName?:string,receiverVarName?:string}
 */
function resolve_identifier_call_context(string $text, int $cursorOffset): ?array
{
    $ident = find_identifier_at_offset($text, $cursorOffset);
    if ($ident === null) {
        return null;
    }
    $name = $ident['name'];
    $start = $ident['start'];
    $end = $ident['end'];

    $k = $end;
    while ($k < strlen($text) && ctype_space($text[$k] ?? '')) {
        $k++;
    }
    if (($text[$k] ?? '') !== '(') {
        return null;
    }

    $j = $start - 1;
    while ($j >= 0 && ctype_space($text[$j] ?? '')) {
        $j--;
    }
    if ($j >= 1 && ($text[$j - 1] ?? '') === ':' && ($text[$j] ?? '') === ':') {
        $classToken = read_identifier_backward($text, $j - 2, '/[A-Za-z0-9_\\\\]/');
        if ($classToken === null) {
            return null;
        }
        return [
            'kind' => 'static',
            'className' => $classToken['word'],
            'methodName' => $name,
        ];
    }
    if ($j >= 1 && ($text[$j - 1] ?? '') === '-' && ($text[$j] ?? '') === '>') {
        $receiver = read_identifier_backward($text, $j - 2, '/[A-Za-z0-9_$]/');
        if ($receiver === null || preg_match('/^\$[A-Za-z_][A-Za-z0-9_]*$/', $receiver['word']) !== 1) {
            return null;
        }
        return [
            'kind' => 'instance',
            'receiverVarName' => substr($receiver['word'], 1),
            'methodName' => $name,
        ];
    }

    $before = read_identifier_backward($text, $start - 1);
    if ($before !== null) {
        $beforeWord = strtolower($before['word']);
        if ($beforeWord === 'function' || $beforeWord === 'fn') {
            return null;
        }
    }
    return [
        'kind' => 'function',
        'name' => $name,
    ];
}

/**
 * @return ?array{name:string,start:int,end:int}
 */
function find_variable_at_offset(string $text, int $offset): ?array
{
    $len = strlen($text);
    if ($len === 0) {
        return null;
    }
    $offset = max(0, min($offset, $len - 1));
    $isVarChar = static function (string $ch): bool {
        return preg_match('/[A-Za-z0-9_$]/', $ch) === 1;
    };

    if (!$isVarChar($text[$offset] ?? '')) {
        if ($offset > 0 && $isVarChar($text[$offset - 1] ?? '')) {
            $offset -= 1;
        } else {
            return null;
        }
    }

    $start = $offset;
    while ($start > 0 && $isVarChar($text[$start - 1] ?? '')) {
        $start--;
    }
    $end = $offset;
    while ($end + 1 < $len && $isVarChar($text[$end + 1] ?? '')) {
        $end++;
    }
    $token = substr($text, $start, $end - $start + 1);
    if (!is_string($token) || preg_match('/^\$[A-Za-z_][A-Za-z0-9_]*$/', $token) !== 1) {
        return null;
    }
    return [
        'name' => substr($token, 1),
        'start' => $start,
        'end' => $end + 1,
    ];
}

/**
 * @return ?array{markdown:string}
 */
function build_hover_payload(
    string $filePath,
    string $text,
    int $cursorOffset
): ?array {
    $reflectionState = get_phpstan_reflection_state($filePath);
    return build_hover_payload_from_scope($filePath, $text, $cursorOffset, $reflectionState);
}

/**
 * @return array<int,string>
 */
function get_function_parameter_names_from_phpstan(
    object $provider,
    string $name,
    string $namespace
): array {
    if (!class_exists('PhpParser\\Node\\Name')) {
        return [];
    }
    if (!interface_exists('PHPStan\\Reflection\\NamespaceAnswerer')) {
        return [];
    }
    $answerer = new class($namespace) implements \PHPStan\Reflection\NamespaceAnswerer {
        public function __construct(
            private string $namespace,
        ) {
        }

        public function getNamespace(): ?string
        {
            return $this->namespace === '' ? null : $this->namespace;
        }
    };

    $candidateNames = [];
    if ($name !== '' && $name[0] === '\\') {
        $candidateNames[] = ltrim($name, '\\');
    } else {
        if ($namespace !== '' && !str_contains($name, '\\')) {
            $candidateNames[] = $namespace . '\\' . $name;
        }
        $candidateNames[] = ltrim($name, '\\');
    }

    foreach ($candidateNames as $candidate) {
        try {
            $nodeName = new \PhpParser\Node\Name($candidate);
            if (!$provider->hasFunction($nodeName, $answerer)) {
                continue;
            }
            $reflection = $provider->getFunction($nodeName, $answerer);
            $params = [];
            foreach ($reflection->getOnlyVariant()->getParameters() as $param) {
                $params[] = $param->getName();
            }
            return $params;
        } catch (Throwable $e) {
            continue;
        }
    }
    return [];
}

function get_function_parameter_names_native(string $name, string $namespace): array
{
    $candidates = [];
    if ($name !== '' && $name[0] === '\\') {
        $candidates[] = ltrim($name, '\\');
    } else {
        if ($namespace !== '' && !str_contains($name, '\\')) {
            $candidates[] = $namespace . '\\' . $name;
        }
        $candidates[] = ltrim($name, '\\');
    }
    foreach ($candidates as $candidate) {
        if (!function_exists($candidate)) {
            continue;
        }
        try {
            $reflection = new ReflectionFunction($candidate);
            $params = [];
            foreach ($reflection->getParameters() as $param) {
                $params[] = $param->getName();
            }
            return $params;
        } catch (Throwable $e) {
            return [];
        }
    }
    return [];
}

/**
 * @param array{namespace:string,useClasses:array<string,string>} $context
 * @return array<int,string>
 */
function get_static_method_parameter_names_from_phpstan(
    object $provider,
    object $scope,
    string $rawClassName,
    string $methodName,
    array $context
): array {
    $className = resolve_class_name($rawClassName, $context);
    if ($className === '') {
        return [];
    }
    try {
        if (!$provider->hasClass($className)) {
            return [];
        }
        $classReflection = $provider->getClass($className);
        if (!$classReflection->hasMethod($methodName)) {
            return [];
        }
        $method = $classReflection->getMethod($methodName, $scope);
        $params = [];
        foreach ($method->getOnlyVariant()->getParameters() as $param) {
            $params[] = $param->getName();
        }
        return $params;
    } catch (Throwable $e) {
        return [];
    }
}

function get_static_method_parameter_names_native(string $rawClassName, string $methodName, array $context): array
{
    $className = resolve_class_name($rawClassName, $context);
    if ($className === '' || !class_exists($className)) {
        return [];
    }
    if (!method_exists($className, $methodName)) {
        return [];
    }
    try {
        $reflection = new ReflectionMethod($className, $methodName);
        $params = [];
        foreach ($reflection->getParameters() as $param) {
            $params[] = $param->getName();
        }
        return $params;
    } catch (Throwable $e) {
        return [];
    }
}

/**
 * @return array<int,string>
 */
function get_instance_method_parameter_names_from_phpstan(
    object $provider,
    object $scope,
    string $className,
    string $methodName
): array {
    try {
        if (!$provider->hasClass($className)) {
            return [];
        }
        $classReflection = $provider->getClass($className);
        if (!$classReflection->hasMethod($methodName)) {
            return [];
        }
        $method = $classReflection->getMethod($methodName, $scope);
        $params = [];
        foreach ($method->getOnlyVariant()->getParameters() as $param) {
            $params[] = $param->getName();
        }
        return $params;
    } catch (Throwable $e) {
        return [];
    }
}

/**
 * @return array<int,string>
 */
function get_instance_method_parameter_names_native(string $className, string $methodName): array
{
    if ($className === '' || !class_exists($className)) {
        return [];
    }
    if (!method_exists($className, $methodName)) {
        return [];
    }
    try {
        $reflection = new ReflectionMethod($className, $methodName);
        $params = [];
        foreach ($reflection->getParameters() as $param) {
            $params[] = $param->getName();
        }
        return $params;
    } catch (Throwable $e) {
        return [];
    }
}

/**
 * @param array<int,string> $paramNames
 * @param array<int, array{start:int,end:int,text:string}> $arguments
 * @return array<int, array{argumentIndex:int,argumentStartOffset:int,parameterName:string,hide:bool}>
 */
function build_argument_hints(array $paramNames, array $arguments, int $rangeStart, int $rangeEnd): array
{
    $count = min(count($paramNames), count($arguments));
    $hints = [];
    for ($i = 0; $i < $count; $i++) {
        $paramName = $paramNames[$i];
        $arg = $arguments[$i];
        if (!is_string($paramName)) {
            continue;
        }
        $hide = false;
        $argText = trim((string) $arg['text']);
        if ($argText === '') {
            $hide = true;
        }
        if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*\s*:/', $argText) === 1) {
            $hide = true;
        }
        if (preg_match('/^\$([A-Za-z_][A-Za-z0-9_]*)$/', $argText, $varMatch) === 1) {
            if (($varMatch[1] ?? '') === $paramName) {
                $hide = true;
            }
        }
        $start = (int) $arg['start'];
        if ($start < $rangeStart || $start > $rangeEnd) {
            continue;
        }
        $hints[] = [
            'argumentIndex' => $i,
            'argumentStartOffset' => $start,
            'parameterName' => $paramName,
            'hide' => $hide,
        ];
    }
    return $hints;
}

/**
 * @param object|null $parser
 * @param array{namespace:string,useClasses:array<string,string>} $context
 * @return array{
 *   calls: array<int, array{
 *     kind:string,
 *     callStartOffset:int,
 *     name?:string,
 *     className?:string,
 *     methodName?:string,
 *     receiverVarName?:string,
 *     arguments: array<int, array{start:int,end:int,text:string}>
 *   }>,
 *   classRanges: array<int, array{start:int,end:int,className:string}>,
 *   variableTypeEvents: array<int, array{offset:int,varName:string,className:string}>
 * }
 */
function build_ast_index(string $text, ?object $parser, array $context): array
{
    if ($parser === null || !method_exists($parser, 'parseString') || !class_exists('PhpParser\\NodeTraverser')) {
        $calls = [];
        $len = strlen($text);
        for ($i = 0; $i < $len; $i++) {
            if (($text[$i] ?? '') !== '(') {
                continue;
            }
            $callable = extract_callable_from_before_paren($text, $i);
            if ($callable === null) {
                continue;
            }
            $closePos = find_matching_paren($text, $i);
            if ($closePos < 0) {
                continue;
            }
            $calls[] = [
                'kind' => $callable['kind'],
                'callStartOffset' => $i,
                'name' => $callable['name'] ?? null,
                'className' => $callable['className'] ?? null,
                'methodName' => $callable['methodName'] ?? null,
                'receiverVarName' => $callable['receiverVarName'] ?? null,
                'arguments' => split_top_level_arguments($text, $i + 1, $closePos),
            ];
            $i = $closePos;
        }
        return [
            'calls' => $calls,
            'classRanges' => collect_class_ranges($text, $context),
            'variableTypeEvents' => collect_variable_type_events($text, $context),
        ];
    }
    try {
        $stmts = $parser->parseString($text);
    } catch (Throwable $e) {
        return [
            'calls' => [],
            'classRanges' => collect_class_ranges($text, $context),
            'variableTypeEvents' => collect_variable_type_events($text, $context),
        ];
    }
    if (!is_array($stmts) || !class_exists('PhpParser\\NodeVisitorAbstract')) {
        return [
            'calls' => [],
            'classRanges' => collect_class_ranges($text, $context),
            'variableTypeEvents' => collect_variable_type_events($text, $context),
        ];
    }

    $visitor = new class($text, $context) extends \PhpParser\NodeVisitorAbstract {
        private string $currentNamespace = '';

        /** @var list<string> */
        private array $classStack = [];

        /** @var list<array{
         *   kind:string,
         *   callStartOffset:int,
         *   name?:string,
         *   className?:string,
         *   methodName?:string,
         *   receiverVarName?:string,
         *   arguments: array<int, array{start:int,end:int,text:string}>
         * }>
         */
        public array $calls = [];

        /** @var list<array{start:int,end:int,className:string}> */
        public array $classRanges = [];
        /** @var list<array{offset:int,varName:string,className:string}> */
        public array $variableTypeEvents = [];

        /**
         * @param array{namespace:string,useClasses:array<string,string>} $context
         */
        public function __construct(
            private string $text,
            private array $context
        ) {
        }

        public function enterNode(\PhpParser\Node $node)
        {
            if ($node instanceof \PhpParser\Node\FunctionLike) {
                $baseOffset = (int) $node->getStartFilePos();
                foreach ($node->getParams() as $param) {
                    if (!($param->var instanceof \PhpParser\Node\Expr\Variable) || !is_string($param->var->name)) {
                        continue;
                    }
                    $typeName = $this->renderTypeNode($param->type);
                    if ($typeName === null || $typeName === '') {
                        continue;
                    }
                    $this->variableTypeEvents[] = [
                        'offset' => $baseOffset,
                        'varName' => $param->var->name,
                        'className' => $typeName,
                    ];
                }
            }
            if ($node instanceof \PhpParser\Node\Stmt\Namespace_) {
                $this->currentNamespace = $node->name?->toString() ?? '';
                return null;
            }
            if ($node instanceof \PhpParser\Node\Stmt\Class_ && $node->name !== null) {
                $className = resolve_class_name($node->name->toString(), [
                    'namespace' => $this->currentNamespace,
                    'useClasses' => $this->context['useClasses'],
                ]);
                $this->classStack[] = $className;
                $start = (int) $node->getStartFilePos();
                $end = (int) $node->getEndFilePos() + 1;
                $this->classRanges[] = [
                    'start' => $start,
                    'end' => $end,
                    'className' => $className,
                ];
                return null;
            }
            if ($node instanceof \PhpParser\Node\Expr\Assign) {
                if (
                    $node->var instanceof \PhpParser\Node\Expr\Variable
                    && is_string($node->var->name)
                    && $node->expr instanceof \PhpParser\Node\Expr\New_
                    && $node->expr->class instanceof \PhpParser\Node\Name
                ) {
                    $rawClass = $node->expr->class->toString();
                    $className = resolve_class_name($rawClass, [
                        'namespace' => $this->currentNamespace,
                        'useClasses' => $this->context['useClasses'],
                    ]);
                    $this->variableTypeEvents[] = [
                        'offset' => (int) $node->getStartFilePos(),
                        'varName' => $node->var->name,
                        'className' => $className,
                    ];
                }
                return null;
            }
            if (
                $node instanceof \PhpParser\Node\Expr\FuncCall
                || $node instanceof \PhpParser\Node\Expr\StaticCall
                || $node instanceof \PhpParser\Node\Expr\MethodCall
            ) {
                $args = [];
                foreach ($node->args as $arg) {
                    $start = (int) $arg->getStartFilePos();
                    $end = (int) $arg->getEndFilePos() + 1;
                    $args[] = trim_segment($this->text, $start, $end);
                }
                if ($node instanceof \PhpParser\Node\Expr\FuncCall && $node->name instanceof \PhpParser\Node\Name) {
                    $this->calls[] = [
                        'kind' => 'function',
                        'callStartOffset' => (int) $node->getStartFilePos(),
                        'name' => $node->name->toString(),
                        'arguments' => $args,
                    ];
                    return null;
                }
                if (
                    $node instanceof \PhpParser\Node\Expr\StaticCall
                    && $node->class instanceof \PhpParser\Node\Name
                    && (is_string($node->name) || $node->name instanceof \PhpParser\Node\Identifier)
                ) {
                    $methodName = is_string($node->name) ? $node->name : $node->name->toString();
                    $this->calls[] = [
                        'kind' => 'static',
                        'callStartOffset' => (int) $node->getStartFilePos(),
                        'className' => $node->class->toString(),
                        'methodName' => $methodName,
                        'arguments' => $args,
                    ];
                    return null;
                }
                if (
                    $node instanceof \PhpParser\Node\Expr\MethodCall
                    && $node->var instanceof \PhpParser\Node\Expr\Variable
                    && is_string($node->var->name)
                    && (is_string($node->name) || $node->name instanceof \PhpParser\Node\Identifier)
                ) {
                    $methodName = is_string($node->name) ? $node->name : $node->name->toString();
                    $this->calls[] = [
                        'kind' => 'instance',
                        'callStartOffset' => (int) $node->getStartFilePos(),
                        'receiverVarName' => $node->var->name,
                        'methodName' => $methodName,
                        'arguments' => $args,
                    ];
                }
            }
            return null;
        }

        private function renderTypeNode($type): ?string
        {
            if ($type === null) {
                return null;
            }
            if ($type instanceof \PhpParser\Node\NullableType) {
                $inner = $this->renderTypeNode($type->type);
                return $inner === null ? null : ('?' . $inner);
            }
            if ($type instanceof \PhpParser\Node\UnionType) {
                $parts = [];
                foreach ($type->types as $part) {
                    $s = $this->renderTypeNode($part);
                    if ($s !== null && $s !== '') {
                        $parts[] = $s;
                    }
                }
                return count($parts) > 0 ? implode('|', $parts) : null;
            }
            if ($type instanceof \PhpParser\Node\IntersectionType) {
                $parts = [];
                foreach ($type->types as $part) {
                    $s = $this->renderTypeNode($part);
                    if ($s !== null && $s !== '') {
                        $parts[] = $s;
                    }
                }
                return count($parts) > 0 ? implode('&', $parts) : null;
            }
            if ($type instanceof \PhpParser\Node\Identifier) {
                return $type->toString();
            }
            if ($type instanceof \PhpParser\Node\Name) {
                return resolve_class_name($type->toString(), [
                    'namespace' => $this->currentNamespace,
                    'useClasses' => $this->context['useClasses'],
                ]);
            }
            return null;
        }

        public function leaveNode(\PhpParser\Node $node)
        {
            if ($node instanceof \PhpParser\Node\Stmt\Class_ && $node->name !== null) {
                array_pop($this->classStack);
            }
            if ($node instanceof \PhpParser\Node\Stmt\Namespace_) {
                $this->currentNamespace = '';
            }
            return null;
        }
    };

    $traverser = new \PhpParser\NodeTraverser();
    $traverser->addVisitor($visitor);
    $traverser->traverse($stmts);

    $varEventsFromDoc = collect_variable_type_events($text, $context);
    foreach ($varEventsFromDoc as $docEvent) {
        $visitor->variableTypeEvents[] = $docEvent;
    }
    usort($visitor->variableTypeEvents, static function (array $a, array $b): int {
        return $a['offset'] <=> $b['offset'];
    });

    return [
        'calls' => $visitor->calls,
        'classRanges' => $visitor->classRanges,
        'variableTypeEvents' => $visitor->variableTypeEvents,
    ];
}

function get_namespace_from_scope($scope): string
{
    if (!is_object($scope) || !method_exists($scope, 'getNamespace')) {
        return '';
    }
    try {
        $namespace = $scope->getNamespace();
        if (is_string($namespace)) {
            return $namespace;
        }
    } catch (Throwable $e) {
        return '';
    }
    return '';
}

/**
 * @return array<int,string>
 */
function get_method_parameter_names_from_class_reflection($classReflection, $scope, string $methodName): array
{
    if (!is_object($classReflection) || $methodName === '') {
        return [];
    }
    if (!method_exists($classReflection, 'hasMethod') || !method_exists($classReflection, 'getMethod')) {
        return [];
    }
    try {
        if (!$classReflection->hasMethod($methodName)) {
            return [];
        }
        $methodReflection = $classReflection->getMethod($methodName, $scope);
        $params = [];
        foreach ($methodReflection->getOnlyVariant()->getParameters() as $param) {
            $params[] = $param->getName();
        }
        return $params;
    } catch (Throwable $e) {
        return [];
    }
}

/**
 * @return array<int,string>
 */
function get_method_parameter_names_from_type(
    object $provider,
    $scope,
    $type,
    string $methodName
): array {
    if (!is_object($type) || $methodName === '') {
        return [];
    }

    /** @var array<int,string> $classNames */
    $classNames = [];
    if (method_exists($type, 'getObjectClassNames')) {
        try {
            $names = $type->getObjectClassNames();
            if (is_array($names)) {
                foreach ($names as $name) {
                    if (is_string($name) && $name !== '') {
                        $classNames[] = $name;
                    }
                }
            }
        } catch (Throwable $e) {
            // Ignore and try the next source.
        }
    }

    if (count($classNames) === 0 && method_exists($type, 'getObjectClassReflections')) {
        try {
            $classReflections = $type->getObjectClassReflections();
            if (is_array($classReflections)) {
                foreach ($classReflections as $classReflection) {
                    if (!is_object($classReflection) || !method_exists($classReflection, 'getName')) {
                        continue;
                    }
                    $name = $classReflection->getName();
                    if (is_string($name) && $name !== '') {
                        $classNames[] = $name;
                    }
                }
            }
        } catch (Throwable $e) {
            return [];
        }
    }

    foreach (array_values(array_unique($classNames)) as $className) {
        try {
            if (!$provider->hasClass($className)) {
                continue;
            }
            $classReflection = $provider->getClass($className);
            $params = get_method_parameter_names_from_class_reflection($classReflection, $scope, $methodName);
            if (count($params) > 0) {
                return $params;
            }
        } catch (Throwable $e) {
            continue;
        }
    }
    return [];
}

/**
 * @return ?array<int, array{callStartOffset:int,hints:array<int, array{argumentIndex:int,argumentStartOffset:int,parameterName:string,hide:bool}>}>
 */
function collect_call_argument_payload_from_scope(
    string $filePath,
    string $text,
    int $rangeStart,
    int $rangeEnd,
    ?array $reflectionState
): ?array {
    if (
        $reflectionState === null
        || !isset($reflectionState['provider'], $reflectionState['parser'], $reflectionState['nodeScopeResolver'], $reflectionState['scopeFactory'])
        || !is_object($reflectionState['provider'])
        || !is_object($reflectionState['parser'])
        || !is_object($reflectionState['nodeScopeResolver'])
        || !is_object($reflectionState['scopeFactory'])
        || !method_exists($reflectionState['parser'], 'parseString')
        || !method_exists($reflectionState['nodeScopeResolver'], 'processNodes')
        || !method_exists($reflectionState['scopeFactory'], 'create')
    ) {
        return null;
    }

    try {
        $stmts = $reflectionState['parser']->parseString($text);
    } catch (Throwable $e) {
        return [];
    }
    if (!is_array($stmts) || !class_exists('PHPStan\\Analyser\\ScopeContext')) {
        return [];
    }

    $scopeContext = \PHPStan\Analyser\ScopeContext::create($filePath);
    $rootScope = $reflectionState['scopeFactory']->create($scopeContext, null);
    $provider = $reflectionState['provider'];

    /** @var array<int, array{start:int,end:int,scope:mixed}> $scopeRanges */
    $scopeRanges = [];
    $reflectionState['nodeScopeResolver']->processNodes(
        $stmts,
        $rootScope,
        static function (\PhpParser\Node $node, $currentScope) use (&$scopeRanges): void {
            $targetNode = null;
            if ($node instanceof \PhpParser\Node\Stmt\ClassMethod || $node instanceof \PhpParser\Node\Stmt\Function_) {
                $targetNode = $node;
            } elseif (is_object($node) && method_exists($node, 'getOriginalNode')) {
                try {
                    $originalNode = $node->getOriginalNode();
                    if (
                        $originalNode instanceof \PhpParser\Node\Stmt\ClassMethod
                        || $originalNode instanceof \PhpParser\Node\Stmt\Function_
                    ) {
                        $targetNode = $originalNode;
                    }
                } catch (Throwable $e) {
                    $targetNode = null;
                }
            }
            if (!($targetNode instanceof \PhpParser\Node)) {
                return;
            }
            $start = (int) $targetNode->getStartFilePos();
            $end = (int) $targetNode->getEndFilePos() + 1;
            if ($start < 0 || $end <= $start) {
                return;
            }
            $scopeRanges[] = [
                'start' => $start,
                'end' => $end,
                'scope' => $currentScope,
            ];
        }
    );

    if (!class_exists('PhpParser\\NodeTraverser') || !class_exists('PhpParser\\NodeVisitorAbstract')) {
        return [];
    }
    $callNodes = [];
    $traverser = new \PhpParser\NodeTraverser();
    $traverser->addVisitor(new class($callNodes) extends \PhpParser\NodeVisitorAbstract {
        /** @var array<int, \PhpParser\Node\Expr\FuncCall|\PhpParser\Node\Expr\MethodCall|\PhpParser\Node\Expr\StaticCall> */
        public $calls = [];
        public function __construct(array &$calls)
        {
            $this->calls = &$calls;
        }
        public function enterNode(\PhpParser\Node $node)
        {
            if (
                $node instanceof \PhpParser\Node\Expr\FuncCall
                || $node instanceof \PhpParser\Node\Expr\MethodCall
                || $node instanceof \PhpParser\Node\Expr\StaticCall
            ) {
                $this->calls[] = $node;
            }
            return null;
        }
    });
    $traverser->traverse($stmts);

    $findScopeForOffset = static function (int $offset) use ($scopeRanges, $rootScope) {
        $selected = $rootScope;
        $selectedLen = PHP_INT_MAX;
        foreach ($scopeRanges as $range) {
            if ($offset < $range['start'] || $offset >= $range['end']) {
                continue;
            }
            $len = $range['end'] - $range['start'];
            if ($len < $selectedLen) {
                $selected = $range['scope'];
                $selectedLen = $len;
            }
        }
        return $selected;
    };

    $payload = [];
    foreach ($callNodes as $node) {
        $callStartOffset = (int) $node->getStartFilePos();
        if ($callStartOffset < 0) {
            continue;
        }
        $currentScope = $findScopeForOffset($callStartOffset);

        $arguments = [];
        foreach ($node->args as $arg) {
            $argStart = (int) $arg->getStartFilePos();
            $argEnd = (int) $arg->getEndFilePos() + 1;
            $arguments[] = trim_segment($text, $argStart, $argEnd);
        }
        if (count($arguments) === 0) {
            continue;
        }

        $params = [];
        if ($node instanceof \PhpParser\Node\Expr\FuncCall && $node->name instanceof \PhpParser\Node\Name) {
            $resolvedName = '';
            if (is_object($currentScope) && method_exists($currentScope, 'resolveName')) {
                try {
                    $resolvedName = (string) $currentScope->resolveName($node->name);
                } catch (Throwable $e) {
                    $resolvedName = '';
                }
            }
            $params = get_function_parameter_names_from_phpstan(
                $provider,
                $resolvedName !== '' ? $resolvedName : $node->name->toString(),
                $resolvedName !== '' ? '' : get_namespace_from_scope($currentScope)
            );
        } elseif (
            $node instanceof \PhpParser\Node\Expr\StaticCall
            && (is_string($node->name) || $node->name instanceof \PhpParser\Node\Identifier)
        ) {
            $methodName = is_string($node->name) ? $node->name : $node->name->toString();
            if ($node->class instanceof \PhpParser\Node\Name) {
                $classToken = strtolower($node->class->toString());
                if (
                    ($classToken === 'self' || $classToken === 'static' || $classToken === 'parent')
                    && is_object($currentScope)
                    && method_exists($currentScope, 'getClassReflection')
                ) {
                    try {
                        $classReflection = $currentScope->getClassReflection();
                        if ($classToken === 'parent' && is_object($classReflection) && method_exists($classReflection, 'getParentClass')) {
                            $classReflection = $classReflection->getParentClass();
                        }
                        $params = get_method_parameter_names_from_class_reflection(
                            $classReflection,
                            $currentScope,
                            $methodName
                        );
                    } catch (Throwable $e) {
                        $params = [];
                    }
                }
                if (count($params) === 0) {
                    $resolvedClassName = '';
                    if (is_object($currentScope) && method_exists($currentScope, 'resolveName')) {
                        try {
                            $resolvedClassName = (string) $currentScope->resolveName($node->class);
                        } catch (Throwable $e) {
                            $resolvedClassName = '';
                        }
                    }
                    $context = [
                        'namespace' => get_namespace_from_scope($currentScope),
                        'useClasses' => [],
                    ];
                    $params = get_static_method_parameter_names_from_phpstan(
                        $provider,
                        $currentScope,
                        $resolvedClassName !== '' ? ('\\' . ltrim($resolvedClassName, '\\')) : $node->class->toString(),
                        $methodName,
                        $context
                    );
                }
            } elseif ($node->class instanceof \PhpParser\Node\Expr && is_object($currentScope) && method_exists($currentScope, 'getType')) {
                try {
                    $classType = $currentScope->getType($node->class);
                } catch (Throwable $e) {
                    $classType = null;
                }
                $params = get_method_parameter_names_from_type($provider, $currentScope, $classType, $methodName);
            }
        } elseif (
            $node instanceof \PhpParser\Node\Expr\MethodCall
            && (is_string($node->name) || $node->name instanceof \PhpParser\Node\Identifier)
            && is_object($currentScope)
            && method_exists($currentScope, 'getType')
        ) {
            $methodName = is_string($node->name) ? $node->name : $node->name->toString();
            try {
                $receiverType = $currentScope->getType($node->var);
            } catch (Throwable $e) {
                $receiverType = null;
            }
            $params = get_method_parameter_names_from_type($provider, $currentScope, $receiverType, $methodName);
        }

        if (count($params) === 0) {
            continue;
        }
        $hints = build_argument_hints($params, $arguments, $rangeStart, $rangeEnd);
        if (count($hints) === 0) {
            continue;
        }
        $payload[] = [
            'callStartOffset' => $callStartOffset,
            'hints' => $hints,
        ];
    }

    return $payload;
}

/**
 * @return array<int, array{callStartOffset:int,hints:array<int, array{argumentIndex:int,argumentStartOffset:int,parameterName:string,hide:bool}>}>
 */
function collect_call_argument_payload(string $filePath, string $text, int $rangeStart, int $rangeEnd): array
{
    $reflectionState = get_phpstan_reflection_state($filePath);
    $fromScope = collect_call_argument_payload_from_scope(
        $filePath,
        $text,
        $rangeStart,
        $rangeEnd,
        $reflectionState
    );
    if (is_array($fromScope)) {
        return $fromScope;
    }
    return [];
}

function handle_resolve_node_context(string $id, array $params): array
{
    $filePath = isset($params['filePath']) && is_string($params['filePath']) ? $params['filePath'] : '';
    $capabilities = isset($params['capabilities']) && is_array($params['capabilities']) ? $params['capabilities'] : [];
    $text = isset($params['text']) && is_string($params['text']) ? $params['text'] : '';
    $cursorOffset = isset($params['cursorOffset']) && is_int($params['cursorOffset'])
        ? $params['cursorOffset']
        : 0;
    $rangeStart = isset($params['rangeStartOffset']) && is_int($params['rangeStartOffset'])
        ? $params['rangeStartOffset']
        : 0;
    $rangeEnd = isset($params['rangeEndOffset']) && is_int($params['rangeEndOffset'])
        ? $params['rangeEndOffset']
        : max(0, strlen($text));

    $result = [];
    if (in_array('callArguments', $capabilities, true) && $filePath !== '' && $text !== '') {
        $result['callArguments'] = collect_call_argument_payload($filePath, $text, $rangeStart, $rangeEnd);
    }
    if (in_array('hover', $capabilities, true) && $filePath !== '' && $text !== '') {
        $hover = build_hover_payload($filePath, $text, $cursorOffset);
        if ($hover !== null) {
            $result['hover'] = $hover;
        }
    }
    return [
        'protocolVersion' => PROTOCOL_VERSION,
        'id' => $id,
        'ok' => true,
        'result' => $result,
    ];
}

function handle_request($payload): array
{
    if (!is_array($payload)) {
        return create_error_response('', 'invalid_request', 'Payload must be an object.');
    }

    $id = isset($payload['id']) && is_string($payload['id']) ? $payload['id'] : '';
    $version = $payload['protocolVersion'] ?? null;
    if ($version !== PROTOCOL_VERSION) {
        return create_error_response($id, 'unsupported_protocol', 'Unsupported protocol version.');
    }

    $method = $payload['method'] ?? null;
    if (!is_string($method)) {
        return create_error_response($id, 'invalid_method', 'Method must be a string.');
    }

    if ($method === 'ping') {
        return [
            'protocolVersion' => PROTOCOL_VERSION,
            'id' => $id,
            'ok' => true,
            'result' => [],
        ];
    }

    if ($method === 'resolveNodeContext') {
        $params = isset($payload['params']) && is_array($payload['params']) ? $payload['params'] : [];
        return handle_resolve_node_context($id, $params);
    }

    return create_error_response($id, 'method_not_found', sprintf('Unknown method: %s', $method));
}

$stdin = fopen('php://stdin', 'rb');
$stdout = fopen('php://stdout', 'wb');

if ($stdin === false || $stdout === false) {
    fwrite(STDERR, "Failed to open stdio streams.\n");
    exit(1);
}

while (($line = fgets($stdin)) !== false) {
    $trimmed = trim($line);
    if ($trimmed === '') {
        continue;
    }
    $decoded = json_decode($trimmed, true);
    if (!is_array($decoded)) {
        $response = create_error_response('', 'invalid_json', 'Failed to parse JSON request.');
    } else {
        $response = handle_request($decoded);
    }
    fwrite($stdout, json_encode($response, JSON_UNESCAPED_SLASHES) . PHP_EOL);
}
