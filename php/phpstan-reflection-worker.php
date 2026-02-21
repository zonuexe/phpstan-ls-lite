<?php

declare(strict_types=1);

use PhpParser\Node;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Expr\FuncCall;
use PhpParser\Node\Expr\MethodCall;
use PhpParser\Node\Expr\StaticCall;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PHPStan\Analyser\NodeScopeResolver;
use PHPStan\Analyser\OutOfClassScope;
use PHPStan\Analyser\Scope;
use PHPStan\Analyser\ScopeContext;
use PHPStan\Analyser\ScopeFactory;
use PHPStan\DependencyInjection\ContainerFactory;
use PHPStan\Parser\Parser;
use PHPStan\Reflection\ClassReflection;
use PHPStan\Reflection\NamespaceAnswerer;
use PHPStan\Reflection\ReflectionProvider;
use PHPStan\Type\Type;
use PHPStan\Type\VerbosityLevel;

/**
 * @phpstan-type reflection_state array{
 *   provider:ReflectionProvider,
 *   scope:OutOfClassScope,
 *   parser:?Parser,
 *   nodeScopeResolver:?NodeScopeResolver,
 *   scopeFactory:?ScopeFactory
 * }
 * @phpstan-type reflection_state_with_root array{
 *   root:string,
 *   provider:ReflectionProvider,
 *   scope:OutOfClassScope,
 *   parser:?Parser,
 *   nodeScopeResolver:?NodeScopeResolver,
 *   scopeFactory:?ScopeFactory
 * }
 * @phpstan-type request_error array{code:string,message:string}
 * @phpstan-type argument_hint array{
 *   argumentIndex:int,
 *   argumentStartOffset:int,
 *   parameterName:string,
 *   hide:bool
 * }
 * @phpstan-type call_argument_payload array{
 *   callStartOffset:int,
 *   hints:list<argument_hint>
 * }
 * @phpstan-type worker_result array{
 *   hover?:array{markdown:string},
 *   callArguments?:list<call_argument_payload>
 * }
 * @phpstan-type worker_response array{
 *   protocolVersion:int,
 *   id:string,
 *   ok:bool,
 *   result?:worker_result,
 *   error?:request_error
 * }
 */
final class PhpstanReflectionWorker
{
    private const PROTOCOL_VERSION = 1;

    /** @var array<string, bool> */
    private array $autoloadLoaded = [];

    /** @var array<string, reflection_state> */
    private array $reflectionStateByRoot = [];

    public function run(): int
    {
        $stdin = fopen('php://stdin', 'rb');
        $stdout = fopen('php://stdout', 'wb');

        if ($stdin === false || $stdout === false) {
            fwrite(STDERR, "Failed to open stdio streams.\n");
            return 1;
        }

        while (($line = fgets($stdin)) !== false) {
            $trimmed = trim($line);
            if ($trimmed === '') {
                continue;
            }

            $decoded = json_decode($trimmed, true);
            if (!is_array($decoded)) {
                $response = $this->createErrorResponse('', 'invalid_json', 'Failed to parse JSON request.');
            } else {
                $response = $this->handleRequest($decoded);
            }

            fwrite($stdout, json_encode($response, JSON_UNESCAPED_SLASHES) . PHP_EOL);
        }

        return 0;
    }

    private function findProjectRoot(string $filePath): ?string
    {
        $dir = is_dir($filePath) ? $filePath : dirname($filePath);
        while (true) {
            $composerJson = "{$dir}/composer.json";
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

    private function ensureProjectAutoload(string $filePath): void
    {
        $root = $this->findProjectRoot($filePath);
        if ($root === null) {
            return;
        }
        if (isset($this->autoloadLoaded[$root])) {
            return;
        }

        $autoload = "{$root}/vendor/autoload.php";
        if (is_file($autoload)) {
            require_once $autoload;
        }

        $phpstanBinAutoload = "{$root}/vendor-bin/phpstan/vendor/autoload.php";
        if (is_file($phpstanBinAutoload)) {
            require_once $phpstanBinAutoload;
        }

        $this->autoloadLoaded[$root] = true;
    }

    /**
     * @return ?reflection_state_with_root
     */
    private function getPhpstanReflectionState(string $filePath): ?array
    {
        $root = $this->findProjectRoot($filePath);
        if ($root === null) {
            return null;
        }

        if (isset($this->reflectionStateByRoot[$root])) {
            $state = $this->reflectionStateByRoot[$root];
            return [
                'root' => $root,
                'provider' => $state['provider'],
                'scope' => $state['scope'],
                'parser' => $state['parser'],
                'nodeScopeResolver' => $state['nodeScopeResolver'],
                'scopeFactory' => $state['scopeFactory'],
            ];
        }

        $this->ensureProjectAutoload($filePath);
        if (!class_exists(ContainerFactory::class) || !class_exists(OutOfClassScope::class)) {
            return null;
        }

        $phpstanPhar = $root . '/vendor/phpstan/phpstan/phpstan.phar';
        if (class_exists(Phar::class) && is_file($phpstanPhar)) {
            try {
                Phar::loadPhar($phpstanPhar, 'phpstan.phar');
            } catch (Throwable) {
                // Ignore; container creation fallback is handled below.
            }
        }

        $provider = null;
        $scope = null;
        $parser = null;
        $nodeScopeResolver = null;
        $scopeFactory = null;

        $tmpDir = sys_get_temp_dir() . '/phpstan-ls-lite/' . sha1($root);
        if (!is_dir($tmpDir)) {
            @mkdir($tmpDir, 0777, true);
        }

        $defaultConfig = "{$root}/phpstan.neon";
        $distConfig = "{$root}/phpstan.neon.dist";
        $configCandidates = [[]];
        if (is_file($defaultConfig)) {
            array_unshift($configCandidates, [$defaultConfig]);
        } elseif (is_file($distConfig)) {
            array_unshift($configCandidates, [$distConfig]);
        }

        foreach ($configCandidates as $configFiles) {
            try {
                $factory = new ContainerFactory($root);
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
                );

                $provider = $container->getByType(ReflectionProvider::class);
                $scope = new OutOfClassScope();
                if ($container->hasService('currentPhpVersionRichParser')) {
                    $parser = $container->getService('currentPhpVersionRichParser');
                } elseif ($container->hasService('currentPhpVersionSimpleParser')) {
                    $parser = $container->getService('currentPhpVersionSimpleParser');
                }
                $nodeScopeResolver = $container->getByType(NodeScopeResolver::class);
                $scopeFactory = $container->getByType(ScopeFactory::class);
                break;
            } catch (Throwable) {
                $provider = null;
                $scope = null;
                $parser = null;
                $nodeScopeResolver = null;
                $scopeFactory = null;
                continue;
            }
        }

        if (!$provider instanceof ReflectionProvider || !$scope instanceof OutOfClassScope) {
            return null;
        }

        $reflectionState = [
            'provider' => $provider,
            'scope' => $scope,
            'parser' => $parser instanceof Parser ? $parser : null,
            'nodeScopeResolver' => $nodeScopeResolver instanceof NodeScopeResolver ? $nodeScopeResolver : null,
            'scopeFactory' => $scopeFactory instanceof ScopeFactory ? $scopeFactory : null,
        ];
        $this->reflectionStateByRoot[$root] = $reflectionState;

        return [
            'root' => $root,
            'provider' => $reflectionState['provider'],
            'scope' => $reflectionState['scope'],
            'parser' => $reflectionState['parser'],
            'nodeScopeResolver' => $reflectionState['nodeScopeResolver'],
            'scopeFactory' => $reflectionState['scopeFactory'],
        ];
    }

    /**
     * @return worker_response
     */
    private function createErrorResponse(string $id, string $code, string $message): array
    {
        return [
            'protocolVersion' => self::PROTOCOL_VERSION,
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
    private function trimSegment(string $text, int $start, int $end): array
    {
        $segment = substr($text, $start, $end - $start);

        $leading = strspn($segment, " \t\n\r\0\x0B");
        $trailing = strlen($segment) - strlen(rtrim($segment));
        $trimmedStart = $start + $leading;
        $trimmedEnd = max($trimmedStart, $end - $trailing);
        $trimmed = substr($text, $trimmedStart, $trimmedEnd - $trimmedStart);

        return [
            'start' => $trimmedStart,
            'end' => $trimmedEnd,
            'text' => $trimmed,
        ];
    }

    /**
     * @param list<string> $paramNames
     * @param list<array{start:int,end:int,text:string}> $arguments
     * @return list<argument_hint>
     */
    private function buildArgumentHints(array $paramNames, array $arguments, int $rangeStart, int $rangeEnd): array
    {
        $count = min(count($paramNames), count($arguments));
        $hints = [];

        for ($i = 0; $i < $count; $i++) {
            $paramName = $paramNames[$i] ?? null;
            $arg = $arguments[$i] ?? null;
            if (!is_string($paramName) || !is_array($arg)) {
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
                if ($varMatch[1] === $paramName) {
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

    private function getNamespaceFromScope(Scope $scope): string
    {
        try {
            return $scope->getNamespace() ?? '';
        } catch (Throwable) {
            return '';
        }
    }

    /**
     * @return list<string>
     */
    private function getFunctionParameterNamesFromPhpstan(
        ReflectionProvider $provider,
        string $name,
        string $namespace
    ): array {
        if (!class_exists(Name::class) || !interface_exists(NamespaceAnswerer::class)) {
            return [];
        }

        // @phpstan-ignore phpstanApi.interface
        $answerer = new class($namespace) implements NamespaceAnswerer {
            public function __construct(private string $namespace)
            {
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
                $nodeName = new Name($candidate);
                if (!$provider->hasFunction($nodeName, $answerer)) {
                    continue;
                }
                $reflection = $provider->getFunction($nodeName, $answerer);
                $params = [];
                foreach ($reflection->getOnlyVariant()->getParameters() as $param) {
                    $params[] = $param->getName();
                }
                return $params;
            } catch (Throwable) {
                continue;
            }
        }

        return [];
    }

    /**
     * @param array{namespace:string,useClasses:array<string,string>} $context
     * @return list<string>
     */
    private function getStaticMethodParameterNamesFromPhpstan(
        ReflectionProvider $provider,
        Scope $scope,
        string $rawClassName,
        string $methodName,
        array $context
    ): array {
        $className = $this->resolveClassName($rawClassName, $context);
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
        } catch (Throwable) {
            return [];
        }
    }

    /**
     * @return list<string>
     */
    private function getMethodParameterNamesFromClassReflection(
        ClassReflection $classReflection,
        Scope $scope,
        string $methodName
    ): array {
        if ($methodName === '') {
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
        } catch (Throwable) {
            return [];
        }
    }

    /**
     * @return list<string>
     */
    private function getMethodParameterNamesFromType(
        ReflectionProvider $provider,
        Scope $scope,
        Type $type,
        string $methodName
    ): array {
        if ($methodName === '') {
            return [];
        }

        $classNames = [];
        try {
            foreach ($type->getObjectClassNames() as $name) {
                if (is_string($name) && $name !== '') {
                    $classNames[] = $name;
                }
            }
        } catch (Throwable) {
            // Ignore and try reflections.
        }

        if (count($classNames) === 0) {
            try {
                foreach ($type->getObjectClassReflections() as $classReflection) {
                    if ($classReflection instanceof ClassReflection) {
                        $classNames[] = $classReflection->getName();
                    }
                }
            } catch (Throwable) {
                return [];
            }
        }

        foreach (array_values(array_unique($classNames)) as $className) {
            try {
                if (!$provider->hasClass($className)) {
                    continue;
                }
                $classReflection = $provider->getClass($className);
                $params = $this->getMethodParameterNamesFromClassReflection($classReflection, $scope, $methodName);
                if (count($params) > 0) {
                    return $params;
                }
            } catch (Throwable) {
                continue;
            }
        }

        return [];
    }

    /**
     * @return ?array{markdown:string}
     * @param reflection_state_with_root $reflectionState
     */
    private function buildHoverPayloadFromScope(
        string $filePath,
        string $text,
        int $cursorOffset,
        array $reflectionState
    ): ?array {
        try {
            $stmts = $reflectionState['parser']->parseString($text);
        } catch (Throwable) {
            return null;
        }
        if (!is_array($stmts) || !class_exists(ScopeContext::class)) {
            return null;
        }

        $scopeContext = ScopeContext::create($filePath);
        $scope = $reflectionState['scopeFactory']->create($scopeContext, null);
        $candidateOffsets = [$cursorOffset];
        if ($cursorOffset > 0) {
            $candidateOffsets[] = $cursorOffset - 1;
        }

        $best = null;

        $reflectionState['nodeScopeResolver']->processNodes(
            $stmts,
            $scope,
            static function (Node $node, Scope $currentScope) use (&$best, $candidateOffsets, $text): void {
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
                if (!$matched || !$node instanceof Expr) {
                    return;
                }

                try {
                    $type = $currentScope->getType($node);
                    $typeString = $type->describe(VerbosityLevel::precise());
                } catch (Throwable) {
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
     * @return ?array{markdown:string}
     */
    private function buildHoverPayload(string $filePath, string $text, int $cursorOffset): ?array
    {
        $reflectionState = $this->getPhpstanReflectionState($filePath);
        if ($reflectionState === null) {
            return null;
        }
        return $this->buildHoverPayloadFromScope($filePath, $text, $cursorOffset, $reflectionState);
    }

    /**
     * @return ?list<call_argument_payload>
     * @param reflection_state_with_root $reflectionState
     */
    private function collectCallArgumentPayloadFromScope(
        string $filePath,
        string $text,
        int $rangeStart,
        int $rangeEnd,
        array $reflectionState
    ): ?array {
        try {
            $stmts = $reflectionState['parser']->parseString($text);
        } catch (Throwable) {
            return [];
        }
        if (!is_array($stmts) || !class_exists(ScopeContext::class)) {
            return [];
        }

        $scopeContext = ScopeContext::create($filePath);
        $rootScope = $reflectionState['scopeFactory']->create($scopeContext, null);
        $provider = $reflectionState['provider'];

        $scopeRanges = [];
        $reflectionState['nodeScopeResolver']->processNodes(
            $stmts,
            $rootScope,
            static function (Node $node, Scope $currentScope) use (&$scopeRanges): void {
                $targetNode = null;
                if ($node instanceof Node\Stmt\ClassMethod || $node instanceof Node\Stmt\Function_) {
                    $targetNode = $node;
                } elseif (method_exists($node, 'getOriginalNode')) {
                    try {
                        $originalNode = $node->getOriginalNode();
                        if ($originalNode instanceof Node\Stmt\ClassMethod || $originalNode instanceof Node\Stmt\Function_) {
                            $targetNode = $originalNode;
                        }
                    } catch (Throwable) {
                        $targetNode = null;
                    }
                }

                if (!$targetNode instanceof Node) {
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

        if (!class_exists(NodeTraverser::class) || !class_exists(NodeVisitorAbstract::class)) {
            return [];
        }

        $traverser = new NodeTraverser();
        $callCollector = new class extends NodeVisitorAbstract {
            /** @var list<FuncCall|MethodCall|StaticCall> */
            public array $calls = [];

            public function enterNode(Node $node)
            {
                if ($node instanceof FuncCall || $node instanceof MethodCall || $node instanceof StaticCall) {
                    $this->calls[] = $node;
                }

                return null;
            }
        };
        $traverser->addVisitor($callCollector);
        $traverser->traverse($stmts);
        $callNodes = $callCollector->calls;

        $findScopeForOffset = static function (int $offset) use ($scopeRanges, $rootScope): Scope {
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
                if (!$arg instanceof Arg) {
                    continue;
                }
                $argStart = (int) $arg->getStartFilePos();
                $argEnd = (int) $arg->getEndFilePos() + 1;
                $arguments[] = $this->trimSegment($text, $argStart, $argEnd);
            }
            if (count($arguments) === 0) {
                continue;
            }

            $params = [];
            if ($node instanceof FuncCall && $node->name instanceof Name) {
                $resolvedName = '';
                try {
                    $resolvedName = (string) $currentScope->resolveName($node->name);
                } catch (Throwable) {
                    $resolvedName = '';
                }
                $params = $this->getFunctionParameterNamesFromPhpstan(
                    $provider,
                    $resolvedName !== '' ? $resolvedName : $node->name->toString(),
                    $resolvedName !== '' ? '' : $this->getNamespaceFromScope($currentScope)
                );
            } elseif ($node instanceof StaticCall && $node->name instanceof Identifier) {
                $methodName = $node->name->toString();
                if ($node->class instanceof Name) {
                    $classToken = strtolower($node->class->toString());
                    if (
                        ($classToken === 'self' || $classToken === 'static' || $classToken === 'parent')
                        && method_exists($currentScope, 'getClassReflection')
                    ) {
                        try {
                            $classReflection = $currentScope->getClassReflection();
                            if (
                                $classToken === 'parent'
                                && $classReflection instanceof ClassReflection
                                && method_exists($classReflection, 'getParentClass')
                            ) {
                                $classReflection = $classReflection->getParentClass();
                            }
                            if ($classReflection instanceof ClassReflection) {
                                $params = $this->getMethodParameterNamesFromClassReflection(
                                    $classReflection,
                                    $currentScope,
                                    $methodName
                                );
                            }
                        } catch (Throwable) {
                            $params = [];
                        }
                    }

                    if (count($params) === 0) {
                        $resolvedClassName = '';
                        try {
                            $resolvedClassName = (string) $currentScope->resolveName($node->class);
                        } catch (Throwable) {
                            $resolvedClassName = '';
                        }

                        $context = [
                            'namespace' => $this->getNamespaceFromScope($currentScope),
                            'useClasses' => [],
                        ];

                        $params = $this->getStaticMethodParameterNamesFromPhpstan(
                            $provider,
                            $currentScope,
                            $resolvedClassName !== '' ? ('\\' . ltrim($resolvedClassName, '\\')) : $node->class->toString(),
                            $methodName,
                            $context
                        );
                    }
                } elseif ($node->class instanceof Expr) {
                    try {
                        $classType = $currentScope->getType($node->class);
                    } catch (Throwable) {
                        $classType = null;
                    }
                    if ($classType instanceof Type) {
                        $params = $this->getMethodParameterNamesFromType($provider, $currentScope, $classType, $methodName);
                    }
                }
            } elseif ($node instanceof MethodCall && $node->name instanceof Identifier) {
                $methodName = $node->name->toString();
                try {
                    $receiverType = $currentScope->getType($node->var);
                } catch (Throwable) {
                    $receiverType = null;
                }
                if ($receiverType instanceof Type) {
                    $params = $this->getMethodParameterNamesFromType($provider, $currentScope, $receiverType, $methodName);
                }
            }

            if (count($params) === 0) {
                continue;
            }

            $hints = $this->buildArgumentHints($params, $arguments, $rangeStart, $rangeEnd);
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
     * @return list<call_argument_payload>
     */
    private function collectCallArgumentPayload(string $filePath, string $text, int $rangeStart, int $rangeEnd): array
    {
        $reflectionState = $this->getPhpstanReflectionState($filePath);
        if ($reflectionState === null) {
            return [];
        }
        $fromScope = $this->collectCallArgumentPayloadFromScope(
            $filePath,
            $text,
            $rangeStart,
            $rangeEnd,
            $reflectionState
        );

        return is_array($fromScope) ? $fromScope : [];
    }

    /**
     * @param array{namespace:string,useClasses:array<string,string>} $context
     */
    private function resolveClassName(string $rawName, array $context): string
    {
        if ($rawName === '') {
            return '';
        }
        if ($rawName[0] === '\\') {
            return ltrim($rawName, '\\');
        }
        if (str_contains($rawName, '\\')) {
            return $context['namespace'] !== ''
                ? $context['namespace'] . '\\' . $rawName
                : $rawName;
        }

        if (isset($context['useClasses'][$rawName])) {
            return $context['useClasses'][$rawName];
        }

        return $context['namespace'] !== ''
            ? $context['namespace'] . '\\' . $rawName
            : $rawName;
    }

    /**
     * @param array<string,array<array-key,array|bool|float|int|string|null>|array|bool|float|int|string|null> $params
     * @return worker_response
     */
    private function handleResolveNodeContext(string $id, array $params): array
    {
        $filePath = isset($params['filePath']) && is_string($params['filePath']) ? $params['filePath'] : '';
        $capabilities = isset($params['capabilities']) && is_array($params['capabilities'])
            ? array_values(array_filter($params['capabilities'], static fn ($v): bool => is_string($v)))
            : [];
        $text = isset($params['text']) && is_string($params['text']) ? $params['text'] : '';
        $cursorOffset = isset($params['cursorOffset']) && is_int($params['cursorOffset']) ? $params['cursorOffset'] : 0;
        $rangeStart = isset($params['rangeStartOffset']) && is_int($params['rangeStartOffset'])
            ? $params['rangeStartOffset']
            : 0;
        $rangeEnd = isset($params['rangeEndOffset']) && is_int($params['rangeEndOffset'])
            ? $params['rangeEndOffset']
            : max(0, strlen($text));

        $result = [];
        if (in_array('callArguments', $capabilities, true) && $filePath !== '' && $text !== '') {
            $result['callArguments'] = $this->collectCallArgumentPayload($filePath, $text, $rangeStart, $rangeEnd);
        }
        if (in_array('hover', $capabilities, true) && $filePath !== '' && $text !== '') {
            $hover = $this->buildHoverPayload($filePath, $text, $cursorOffset);
            if ($hover !== null) {
                $result['hover'] = $hover;
            }
        }

        return [
            'protocolVersion' => self::PROTOCOL_VERSION,
            'id' => $id,
            'ok' => true,
            'result' => $result,
        ];
    }

    /**
     * @param array<array-key,array|bool|float|int|string|null>|bool|float|int|string|null $payload
     * @return worker_response
     */
    private function handleRequest(array|bool|float|int|string|null $payload): array
    {
        if (!is_array($payload)) {
            return $this->createErrorResponse('', 'invalid_request', 'Payload must be an object.');
        }

        $id = isset($payload['id']) && is_string($payload['id']) ? $payload['id'] : '';
        $version = $payload['protocolVersion'] ?? null;
        if ($version !== self::PROTOCOL_VERSION) {
            return $this->createErrorResponse($id, 'unsupported_protocol', 'Unsupported protocol version.');
        }

        $method = $payload['method'] ?? null;
        if (!is_string($method)) {
            return $this->createErrorResponse($id, 'invalid_method', 'Method must be a string.');
        }

        if ($method === 'ping') {
            return [
                'protocolVersion' => self::PROTOCOL_VERSION,
                'id' => $id,
                'ok' => true,
                'result' => [],
            ];
        }

        if ($method === 'resolveNodeContext') {
            $params = isset($payload['params']) && is_array($payload['params']) ? $payload['params'] : [];
            return $this->handleResolveNodeContext($id, $params);
        }

        return $this->createErrorResponse($id, 'method_not_found', sprintf('Unknown method: %s', $method));
    }
}

$worker = new PhpstanReflectionWorker();
exit($worker->run());
