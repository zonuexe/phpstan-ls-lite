<?php

declare(strict_types=1);

use PhpParser\Node;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Expr\ClassConstFetch;
use PhpParser\Node\Expr\FuncCall;
use PhpParser\Node\Expr\MethodCall;
use PhpParser\Node\Expr\New_;
use PhpParser\Node\Expr\StaticCall;
use PhpParser\Node\Expr\StaticPropertyFetch;
use PhpParser\Node\Expr\Variable;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Stmt\ClassLike;
use PhpParser\Node\Stmt\Function_;
use PhpParser\Node\Stmt\Namespace_;
use PhpParser\Node\VarLikeIdentifier;
use PHPStan\Analyser\NodeScopeResolver;
use PHPStan\Analyser\Scope;
use PHPStan\Analyser\ScopeContext;
use PHPStan\Analyser\ScopeFactory;
use PHPStan\DependencyInjection\ContainerFactory;
use PHPStan\Parser\Parser;
use PHPStan\Reflection\ClassReflection;
use PHPStan\Reflection\FunctionReflection;
use PHPStan\Reflection\MethodReflection;
use PHPStan\Reflection\NamespaceAnswerer;
use PHPStan\Reflection\ReflectionProvider;
use PHPStan\Type\Type;
use PHPStan\Type\VerbosityLevel;

/**
 * @phpstan-type reflection_state array{
 *   provider:ReflectionProvider,
 *   parser:Parser,
 *   nodeScopeResolver:NodeScopeResolver,
 *   scopeFactory:ScopeFactory
 * }
 * @phpstan-type reflection_state_with_root array{
 *   root:string,
 *   provider:ReflectionProvider,
 *   parser:Parser,
 *   nodeScopeResolver:NodeScopeResolver,
 *   scopeFactory:ScopeFactory
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
 * @phpstan-type definition_location array{
 *   filePath: string,
 *   line: int,
 *   character:int,
 * }
 * @phpstan-type worker_result array{
 *   hover?: array{markdown: string},
 *   callArguments?: list<call_argument_payload>,
 *   definitions?: list<definition_location>,
 * }
 * @phpstan-type local_definition_index array{
 *   functions: array<string, definition_location>,
 *   methods: array<string, array<string, definition_location>>,
 *   classes: array<string, definition_location>,
 *   properties: array<string, array<string, definition_location>>,
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
                'parser' => $state['parser'],
                'nodeScopeResolver' => $state['nodeScopeResolver'],
                'scopeFactory' => $state['scopeFactory'],
            ];
        }

        $this->ensureProjectAutoload($filePath);
        if (!class_exists(ContainerFactory::class)) {
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
                $parser = null;
                if ($container->hasService('currentPhpVersionRichParser')) {
                    $resolvedParser = $container->getService('currentPhpVersionRichParser');
                    $parser = $resolvedParser instanceof Parser ? $resolvedParser : null;
                } elseif ($container->hasService('currentPhpVersionSimpleParser')) {
                    $resolvedParser = $container->getService('currentPhpVersionSimpleParser');
                    $parser = $resolvedParser instanceof Parser ? $resolvedParser : null;
                }
                if ($parser === null) {
                    continue;
                }
                $nodeScopeResolver = $container->getByType(NodeScopeResolver::class);
                $scopeFactory = $container->getByType(ScopeFactory::class);

                $reflectionState = [
                    'provider' => $provider,
                    'parser' => $parser,
                    'nodeScopeResolver' => $nodeScopeResolver,
                    'scopeFactory' => $scopeFactory,
                ];
                $this->reflectionStateByRoot[$root] = $reflectionState;

                return [
                    'root' => $root,
                    'provider' => $reflectionState['provider'],
                    'parser' => $reflectionState['parser'],
                    'nodeScopeResolver' => $reflectionState['nodeScopeResolver'],
                    'scopeFactory' => $reflectionState['scopeFactory'],
                ];
            } catch (Throwable) {
                continue;
            }
        }
        return null;
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
     * @param list<int> $candidateOffsets
     */
    private function hasMatchedOffset(array $candidateOffsets, int $start, int $end): bool
    {
        foreach ($candidateOffsets as $offset) {
            if ($offset >= $start && $offset < $end) {
                return true;
            }
        }

        return false;
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
            public function __construct(
                private string $namespace
            )
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

    private function getFunctionReflectionFromPhpstan(
        ReflectionProvider $provider,
        string $name,
        string $namespace,
    ): ?FunctionReflection {
        if (!class_exists(Name::class) || !interface_exists(NamespaceAnswerer::class)) {
            return null;
        }

        $answerer = new class($namespace) implements NamespaceAnswerer {
            public function __construct(
                private string $namespace
            )
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
                return $provider->getFunction($nodeName, $answerer);
            } catch (Throwable) {
                continue;
            }
        }

        return null;
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

    private function getMethodReflectionFromClassReflection(
        ClassReflection $classReflection,
        Scope $scope,
        string $methodName,
    ): ?MethodReflection {
        if ($methodName === '' || !$classReflection->hasMethod($methodName)) {
            return null;
        }
        try {
            return $classReflection->getMethod($methodName, $scope);
        } catch (Throwable) {
            return null;
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

        foreach ($type->getObjectClassNames() as $className) {
            if (!$provider->hasClass($className)) {
                continue;
            }
            $classReflection = $provider->getClass($className);
            $params = $this->getMethodParameterNamesFromClassReflection($classReflection, $scope, $methodName);
            if (count($params) > 0) {
                return $params;
            }
        }

        foreach ($type->getObjectClassReflections() as $classReflection) {
            $params = $this->getMethodParameterNamesFromClassReflection($classReflection, $scope, $methodName);
            if (count($params) > 0) {
                return $params;
            }
        }

        return [];
    }

    private function getMethodReflectionFromType(
        ReflectionProvider $provider,
        Scope $scope,
        Type $type,
        string $methodName,
    ): ?MethodReflection {
        if ($methodName === '') {
            return null;
        }

        foreach ($type->getObjectClassNames() as $className) {
            if (!$provider->hasClass($className)) {
                continue;
            }
            $classReflection = $provider->getClass($className);
            $methodReflection = $this->getMethodReflectionFromClassReflection(
                $classReflection,
                $scope,
                $methodName
            );
            if ($methodReflection !== null) {
                return $methodReflection;
            }
        }

        foreach ($type->getObjectClassReflections() as $classReflection) {
            $methodReflection = $this->getMethodReflectionFromClassReflection(
                $classReflection,
                $scope,
                $methodName,
            );
            if ($methodReflection !== null) {
                return $methodReflection;
            }
        }

        return null;
    }

    /**
     * @return ?definition_location
     */
    private function buildDefinitionLocation(string $filePath, int $line): ?array
    {
        if ($filePath === '') {
            return null;
        }

        return [
            'filePath' => $filePath,
            'line' => max(0, $line - 1),
            'character' => 0,
        ];
    }

    /**
     * @return ?definition_location
     */
    private function getDefinitionLocationFromFunctionReflection(FunctionReflection $functionReflection): ?array
    {
        $fileName = $functionReflection->getFileName();
        if (!is_string($fileName) || $fileName === '') {
            return null;
        }
        $line = 1;
        $functionName = $functionReflection->getName();
        if ($functionName !== '' && function_exists($functionName)) {
            $line = (new ReflectionFunction($functionName))->getStartLine() ?: 0;
        }

        return $this->buildDefinitionLocation($fileName, $line);
    }

    /**
     * @return ?definition_location
     */
    private function getDefinitionLocationFromMethodReflection(MethodReflection $methodReflection): ?array
    {
        $declaringClass = $methodReflection->getDeclaringClass();
        $fileName = $declaringClass->getFileName();
        if (!is_string($fileName) || $fileName === '') {
            return null;
        }
        $line = 1;
        $nativeReflection = $declaringClass->getNativeReflection();
        $methodName = $methodReflection->getName();
        if ($methodName !== '' && $nativeReflection->hasMethod($methodName)) {
            $line = $nativeReflection->getMethod($methodName)->getStartLine() ?: 0;
        }

        return $this->buildDefinitionLocation($fileName, $line);
    }

    /**
     * @return ?definition_location
     */
    private function getDefinitionLocationFromClassReflection(ClassReflection $classReflection): ?array
    {
        $fileName = $classReflection->getFileName();
        if (!is_string($fileName) || $fileName === '') {
            return null;
        }
        $line = $classReflection->getNativeReflection()->getStartLine() ?: 0;

        return $this->buildDefinitionLocation($fileName, $line);
    }

    /**
     * @param array<Node\Stmt> $stmts
     * @return local_definition_index
     */
    private function buildLocalDefinitionIndex(array $stmts, string $filePath): array
    {
        $index = [
            'functions' => [],
            'methods' => [],
            'classes' => [],
            'properties' => [],
        ];
        $this->collectLocalDefinitionIndex($stmts, '', $filePath, $index);

        return $index;
    }

    /**
     * @param array<Node\Stmt> $stmts
     * @param local_definition_index $index
     */
    private function collectLocalDefinitionIndex(array $stmts, string $namespace, string $filePath, array &$index): void
    {
        foreach ($stmts as $stmt) {
            if ($stmt instanceof Namespace_) {
                $nextNamespace = $stmt->name === null ? '' : $stmt->name->toString();
                $this->collectLocalDefinitionIndex($stmt->stmts, $nextNamespace, $filePath, $index);
                continue;
            }

            if ($stmt instanceof Function_) {
                $functionName = ltrim($namespace . '\\' . $stmt->name->toString(), '\\');
                $location = $this->buildDefinitionLocation($filePath, $stmt->getStartLine());
                if ($location !== null) {
                    $index['functions'][strtolower($functionName)] = $location;
                }
                continue;
            }

            if ($stmt instanceof ClassLike && $stmt->name instanceof Identifier) {
                $className = ltrim($namespace . '\\' . $stmt->name->toString(), '\\');
                $classKey = strtolower($className);
                $classLocation = $this->buildDefinitionLocation($filePath, $stmt->getStartLine());
                if ($classLocation !== null) {
                    $index['classes'][$classKey] = $classLocation;
                }
                if (!isset($index['methods'][$classKey])) {
                    $index['methods'][$classKey] = [];
                }
                if (!isset($index['properties'][$classKey])) {
                    $index['properties'][$classKey] = [];
                }
                foreach ($stmt->getMethods() as $method) {
                    $methodKey = strtolower($method->name->toString());
                    $location = $this->buildDefinitionLocation($filePath, $method->getStartLine());
                    if ($location !== null) {
                        $index['methods'][$classKey][$methodKey] = $location;
                    }
                }
                foreach ($stmt->getProperties() as $property) {
                    foreach ($property->props as $propertyNode) {
                        $propertyKey = strtolower($propertyNode->name->toString());
                        $location = $this->buildDefinitionLocation($filePath, $propertyNode->getStartLine());
                        if ($location !== null) {
                            $index['properties'][$classKey][$propertyKey] = $location;
                        }
                    }
                }
                continue;
            }
        }
    }

    /**
     * @param local_definition_index $localDefinitions
     * @return ?definition_location
     */
    private function findLocalFunctionDefinition(
        array $localDefinitions,
        string $functionName,
        string $namespace,
    ): ?array {
        if ($functionName === '') {
            return null;
        }

        $candidates = [];
        if (str_contains($functionName, '\\')) {
            $candidates[] = ltrim($functionName, '\\');
        } else {
            if ($namespace !== '') {
                $candidates[] = $namespace . '\\' . $functionName;
            }
            $candidates[] = $functionName;
        }

        foreach ($candidates as $candidate) {
            $key = strtolower(ltrim($candidate, '\\'));
            if (isset($localDefinitions['functions'][$key])) {
                return $localDefinitions['functions'][$key];
            }
        }

        return null;
    }

    /**
     * @param local_definition_index $localDefinitions
     * @param list<string> $classNames
     * @return ?definition_location
     */
    private function findLocalMethodDefinition(array $localDefinitions, array $classNames, string $methodName): ?array
    {
        if ($methodName === '') {
            return null;
        }

        $methodKey = strtolower($methodName);
        foreach ($classNames as $className) {
            $classKey = strtolower(ltrim($className, '\\'));
            if (isset($localDefinitions['methods'][$classKey][$methodKey])) {
                return $localDefinitions['methods'][$classKey][$methodKey];
            }
        }

        return null;
    }

    /**
     * @param local_definition_index $localDefinitions
     * @return ?definition_location
     */
    private function findLocalClassDefinition(array $localDefinitions, string $className, string $namespace): ?array
    {
        if ($className === '') {
            return null;
        }

        $candidates = [];
        if (str_contains($className, '\\')) {
            $candidates[] = ltrim($className, '\\');
        } else {
            if ($namespace !== '') {
                $candidates[] = $namespace . '\\' . $className;
            }
            $candidates[] = $className;
        }

        foreach ($candidates as $candidate) {
            $key = strtolower(ltrim($candidate, '\\'));
            if (isset($localDefinitions['classes'][$key])) {
                return $localDefinitions['classes'][$key];
            }
        }

        return null;
    }

    /**
     * @param local_definition_index $localDefinitions
     * @param list<string> $classNames
     * @return ?definition_location
     */
    private function findLocalPropertyDefinition(array $localDefinitions, array $classNames, string $propertyName): ?array
    {
        if ($propertyName === '') {
            return null;
        }

        $propertyKey = strtolower($propertyName);
        foreach ($classNames as $className) {
            $classKey = strtolower(ltrim($className, '\\'));
            if (isset($localDefinitions['properties'][$classKey][$propertyKey])) {
                return $localDefinitions['properties'][$classKey][$propertyKey];
            }
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private function getClassNamesFromType(Type $type): array
    {
        $classNames = $type->getObjectClassNames();
        foreach ($type->getObjectClassReflections() as $classReflection) {
            $classNames[] = $classReflection->getName();
        }

        return array_values(array_unique($classNames));
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
                $start = $node->getStartFilePos();
                $end = $node->getEndFilePos() + 1;
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
                if ($typeString === '') {
                    return;
                }

                $len = $end - $start;
                if ($best !== null && $best['len'] <= $len) {
                    return;
                }

                $exprText = substr($text, $start, $len);
                if ($exprText === '') {
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
     * @param reflection_state_with_root $reflectionState
     * @return list<definition_location>
     */
    private function collectDefinitionPayloadFromScope(
        string $filePath,
        string $text,
        int $cursorOffset,
        array $reflectionState
    ): array {
        try {
            $stmts = $reflectionState['parser']->parseString($text);
        } catch (Throwable) {
            return [];
        }
        $scopeContext = ScopeContext::create($filePath);
        $rootScope = $reflectionState['scopeFactory']->create($scopeContext, null);
        $provider = $reflectionState['provider'];
        $localDefinitions = $this->buildLocalDefinitionIndex($stmts, $filePath);
        $candidateOffsets = [$cursorOffset];
        if ($cursorOffset > 0) {
            $candidateOffsets[] = $cursorOffset - 1;
        }

        $bestLength = PHP_INT_MAX;
        $bestDefinition = null;
        $reflectionState['nodeScopeResolver']->processNodes(
            $stmts,
            $rootScope,
            function (Node $node, Scope $currentScope) use (
                &$bestLength,
                &$bestDefinition,
                $candidateOffsets,
                $provider,
                $localDefinitions
            ): void {
                if (
                    !$node instanceof FuncCall
                    && !$node instanceof MethodCall
                    && !$node instanceof StaticCall
                    && !$node instanceof StaticPropertyFetch
                    && !$node instanceof New_
                    && !$node instanceof ClassConstFetch
                    && !$node instanceof Name
                ) {
                    return;
                }

                $start = $node->getStartFilePos();
                $end = $node->getEndFilePos() + 1;
                if ($start < 0 || $end <= $start) {
                    return;
                }

                $matched = $this->hasMatchedOffset($candidateOffsets, $start, $end);
                if (!$matched) {
                    return;
                }

                $nodeLength = $end - $start;
                if ($nodeLength >= $bestLength) {
                    return;
                }

                $definition = null;
                if ($node instanceof Name) {
                    $namespace = $this->getNamespaceFromScope($currentScope);
                    $resolvedClassName = '';
                    try {
                        $resolvedClassName = (string) $currentScope->resolveName($node);
                    } catch (Throwable) {
                        $resolvedClassName = '';
                    }
                    $className = $resolvedClassName !== ''
                        ? ltrim($resolvedClassName, '\\')
                        : ltrim($node->toString(), '\\');
                    if ($className !== '' && $provider->hasClass($className)) {
                        $classReflection = $provider->getClass($className);
                        $definition = $this->getDefinitionLocationFromClassReflection($classReflection);
                    }
                    if ($definition === null) {
                        $definition = $this->findLocalClassDefinition($localDefinitions, $className, $namespace);
                    }
                } elseif ($node instanceof FuncCall && $node->name instanceof Name) {
                    $resolvedName = '';
                    $namespace = $this->getNamespaceFromScope($currentScope);
                    try {
                        $resolvedName = (string) $currentScope->resolveName($node->name);
                    } catch (Throwable) {
                        $resolvedName = '';
                    }
                    $functionReflection = $this->getFunctionReflectionFromPhpstan(
                        $provider,
                        $resolvedName !== '' ? $resolvedName : $node->name->toString(),
                        $resolvedName !== '' ? '' : $namespace
                    );
                    if ($functionReflection !== null) {
                        $definition = $this->getDefinitionLocationFromFunctionReflection($functionReflection);
                    }
                    if ($definition === null) {
                        $definition = $this->findLocalFunctionDefinition(
                            $localDefinitions,
                            $resolvedName !== '' ? $resolvedName : $node->name->toString(),
                            $namespace
                        );
                    }
                } elseif ($node instanceof StaticCall && $node->name instanceof Identifier) {
                    if ($node->class instanceof Name) {
                        $classStart = $node->class->getStartFilePos();
                        $classEnd = $node->class->getEndFilePos() + 1;
                        if (
                            $classStart >= 0
                            && $classEnd > $classStart
                            && $this->hasMatchedOffset($candidateOffsets, $classStart, $classEnd)
                        ) {
                            $resolvedClassName = '';
                            try {
                                $resolvedClassName = (string) $currentScope->resolveName($node->class);
                            } catch (Throwable) {
                                $resolvedClassName = '';
                            }
                            $className = $resolvedClassName !== ''
                                ? ltrim($resolvedClassName, '\\')
                                : $node->class->toString();
                            if ($className !== '' && $provider->hasClass($className)) {
                                $definition = $this->getDefinitionLocationFromClassReflection(
                                    $provider->getClass($className)
                                );
                            }
                            if ($definition === null) {
                                $definition = $this->findLocalClassDefinition(
                                    $localDefinitions,
                                    $className,
                                    $this->getNamespaceFromScope($currentScope),
                                );
                            }
                        }
                    }

                    if ($definition === null) {
                        $methodName = $node->name->toString();
                        $methodReflection = null;
                        $classNames = [];

                        if ($node->class instanceof Name) {
                            $classToken = strtolower($node->class->toString());
                            if (in_array($classToken, ['self', 'static', 'parent'], true)) {
                                $classReflection = null;
                                try {
                                    $currentClassReflection = $currentScope->getClassReflection();
                                    if ($currentClassReflection instanceof ClassReflection) {
                                        $classReflection = $currentClassReflection;
                                        $classNames[] = $classReflection->getName();
                                    }
                                    if ($classReflection !== null && $classToken === 'parent') {
                                        $parentClassReflection = $classReflection->getParentClass();
                                        $classReflection = $parentClassReflection instanceof ClassReflection
                                            ? $parentClassReflection
                                            : null;
                                        if ($classReflection !== null) {
                                            $classNames[] = $classReflection->getName();
                                        }
                                    }
                                } catch (Throwable) {
                                    $classReflection = null;
                                }
                                if ($classReflection !== null) {
                                    $methodReflection = $this->getMethodReflectionFromClassReflection(
                                        $classReflection,
                                        $currentScope,
                                        $methodName,
                                    );
                                }
                            }

                            if ($methodReflection === null) {
                                $resolvedClassName = '';
                                try {
                                    $resolvedClassName = (string) $currentScope->resolveName($node->class);
                                } catch (Throwable) {
                                    $resolvedClassName = '';
                                }
                                $className = $resolvedClassName !== ''
                                    ? ltrim($resolvedClassName, '\\')
                                    : $node->class->toString();
                                $classNames[] = $className;
                                if ($provider->hasClass($className)) {
                                    $classReflection = $provider->getClass($className);
                                    $methodReflection = $this->getMethodReflectionFromClassReflection(
                                        $classReflection,
                                        $currentScope,
                                        $methodName,
                                    );
                                }
                            }
                        } elseif ($node->class instanceof Expr) {
                            try {
                                $classType = $currentScope->getType($node->class);
                            } catch (Throwable) {
                                $classType = null;
                            }
                            if ($classType instanceof Type) {
                                $classNames = $this->getClassNamesFromType($classType);
                                $methodReflection = $this->getMethodReflectionFromType(
                                    $provider,
                                    $currentScope,
                                    $classType,
                                    $methodName
                                );
                            }
                        }

                        if ($methodReflection !== null) {
                            $definition = $this->getDefinitionLocationFromMethodReflection($methodReflection);
                        }
                        if ($definition === null) {
                            $definition = $this->findLocalMethodDefinition($localDefinitions, $classNames, $methodName);
                        }
                    }
                } elseif ($node instanceof New_ && $node->class instanceof Name) {
                    $resolvedClassName = '';
                    try {
                        $resolvedClassName = (string) $currentScope->resolveName($node->class);
                    } catch (Throwable) {
                        $resolvedClassName = '';
                    }
                    $className = $resolvedClassName !== ''
                        ? ltrim($resolvedClassName, '\\')
                        : $node->class->toString();
                    if ($className !== '' && $provider->hasClass($className)) {
                        $definition = $this->getDefinitionLocationFromClassReflection($provider->getClass($className));
                    }
                    if ($definition === null) {
                        $definition = $this->findLocalClassDefinition(
                            $localDefinitions,
                            $className,
                            $this->getNamespaceFromScope($currentScope)
                        );
                    }
                } elseif ($node instanceof ClassConstFetch && $node->class instanceof Name) {
                    $resolvedClassName = '';
                    try {
                        $resolvedClassName = (string) $currentScope->resolveName($node->class);
                    } catch (Throwable) {
                        $resolvedClassName = '';
                    }
                    $className = $resolvedClassName !== ''
                        ? ltrim($resolvedClassName, '\\')
                        : $node->class->toString();
                    if ($className !== '' && $provider->hasClass($className)) {
                        $definition = $this->getDefinitionLocationFromClassReflection($provider->getClass($className));
                    }
                    if ($definition === null) {
                        $definition = $this->findLocalClassDefinition(
                            $localDefinitions,
                            $className,
                            $this->getNamespaceFromScope($currentScope)
                        );
                    }
                } elseif (
                    $node instanceof StaticPropertyFetch
                    && $node->class instanceof Name
                    && $node->name instanceof VarLikeIdentifier
                ) {
                    $classStart = $node->class->getStartFilePos();
                    $classEnd = $node->class->getEndFilePos() + 1;
                    if (
                        $classStart >= 0
                        && $classEnd > $classStart
                        && $this->hasMatchedOffset($candidateOffsets, $classStart, $classEnd)
                    ) {
                        $resolvedClassName = '';
                        try {
                            $resolvedClassName = (string) $currentScope->resolveName($node->class);
                        } catch (Throwable) {
                            $resolvedClassName = '';
                        }
                        $className = $resolvedClassName !== ''
                            ? ltrim($resolvedClassName, '\\')
                            : $node->class->toString();
                        if ($className !== '' && $provider->hasClass($className)) {
                            $definition = $this->getDefinitionLocationFromClassReflection($provider->getClass($className));
                        }
                        if ($definition === null) {
                            $definition = $this->findLocalClassDefinition(
                                $localDefinitions,
                                $className,
                                $this->getNamespaceFromScope($currentScope)
                            );
                        }
                    }

                    if ($definition === null) {
                        $propertyName = $node->name->toString();
                        $classNames = [];
                        $classToken = strtolower($node->class->toString());
                        if (in_array($classToken, ['self', 'static', 'parent'], true)) {
                            $classReflection = $currentScope->getClassReflection();
                            if ($classReflection !== null) {
                                $classNames[] = $classReflection->getName();
                                if ($classToken === 'parent') {
                                    $parentClass = $classReflection->getParentClass();
                                    if ($parentClass !== null) {
                                        $classNames[] = $parentClass->getName();
                                    }
                                }
                            }
                        } else {
                            $resolvedClassName = '';
                            try {
                                $resolvedClassName = (string) $currentScope->resolveName($node->class);
                            } catch (Throwable) {
                                $resolvedClassName = '';
                            }
                            $className = $resolvedClassName !== ''
                                ? ltrim($resolvedClassName, '\\')
                                : $node->class->toString();
                            if ($className !== '') {
                                $classNames[] = $className;
                            }
                        }

                        $definition = $this->findLocalPropertyDefinition($localDefinitions, $classNames, $propertyName);
                    }
                } elseif ($node instanceof MethodCall && $node->name instanceof Identifier) {
                    $methodName = $node->name->toString();
                    $classNames = [];
                    try {
                        $receiverType = $currentScope->getType($node->var);
                    } catch (Throwable) {
                        $receiverType = null;
                    }
                    if ($receiverType instanceof Type) {
                        $classNames = $this->getClassNamesFromType($receiverType);
                        $methodReflection = $this->getMethodReflectionFromType(
                            $provider,
                            $currentScope,
                            $receiverType,
                            $methodName,
                        );
                        if ($methodReflection !== null) {
                            $definition = $this->getDefinitionLocationFromMethodReflection($methodReflection);
                        }
                    }
                    if ($node->var instanceof Variable && $node->var->name === 'this') {
                        try {
                            $currentClassReflection = $currentScope->getClassReflection();
                            if ($currentClassReflection instanceof ClassReflection) {
                                $classNames[] = $currentClassReflection->getName();
                            }
                        } catch (Throwable) {
                            // Ignore fallback lookup failures.
                        }
                    }
                    if ($definition === null) {
                        $definition = $this->findLocalMethodDefinition($localDefinitions, $classNames, $methodName);
                    }
                }

                if ($definition === null) {
                    return;
                }

                $bestLength = $nodeLength;
                $bestDefinition = $definition;
            }
        );

        return $bestDefinition === null ? [] : [$bestDefinition];
    }

    /**
     * @return list<definition_location>
     */
    private function collectDefinitionPayload(string $filePath, string $text, int $cursorOffset): array
    {
        $reflectionState = $this->getPhpstanReflectionState($filePath);
        if ($reflectionState === null) {
            return [];
        }
        return $this->collectDefinitionPayloadFromScope($filePath, $text, $cursorOffset, $reflectionState);
    }

    /**
     * @return list<call_argument_payload>
     * @param reflection_state_with_root $reflectionState
     */
    private function collectCallArgumentPayloadFromScope(
        string $filePath,
        string $text,
        int $rangeStart,
        int $rangeEnd,
        array $reflectionState,
    ): array {
        try {
            $stmts = $reflectionState['parser']->parseString($text);
        } catch (Throwable) {
            return [];
        }
        $scopeContext = ScopeContext::create($filePath);
        $rootScope = $reflectionState['scopeFactory']->create($scopeContext, null);
        $provider = $reflectionState['provider'];

        $payload = [];
        $reflectionState['nodeScopeResolver']->processNodes(
            $stmts,
            $rootScope,
            function (Node $node, Scope $currentScope) use (
                &$payload,
                $provider,
                $rangeStart,
                $rangeEnd,
                $text,
            ): void {
                if (!$node instanceof FuncCall && !$node instanceof MethodCall && !$node instanceof StaticCall) {
                    return;
                }
                $callStartOffset = $node->getStartFilePos();
                if ($callStartOffset < 0) {
                    return;
                }

                $arguments = [];
                foreach ($node->args as $arg) {
                    if (!$arg instanceof Arg) {
                        continue;
                    }
                    $argStart = $arg->getStartFilePos();
                    $argEnd = $arg->getEndFilePos() + 1;
                    $arguments[] = $this->trimSegment($text, $argStart, $argEnd);
                }
                if (count($arguments) === 0) {
                    return;
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
                        $resolvedName !== '' ? '' : $this->getNamespaceFromScope($currentScope),
                    );
                } elseif ($node instanceof StaticCall && $node->name instanceof Identifier) {
                    $methodName = $node->name->toString();
                    if ($node->class instanceof Name) {
                        $classToken = strtolower($node->class->toString());
                        if (in_array($classToken, ['self', 'static', 'parent'], true)) {
                            $classReflection = null;
                            try {
                                $currentClassReflection = $currentScope->getClassReflection();
                                if ($currentClassReflection instanceof ClassReflection) {
                                    $classReflection = $currentClassReflection;
                                }

                                if ($classReflection !== null && $classToken === 'parent') {
                                    $parentClassReflection = $classReflection->getParentClass();
                                    $classReflection = $parentClassReflection instanceof ClassReflection
                                        ? $parentClassReflection
                                        : null;
                                }

                                if ($classReflection !== null) {
                                    $params = $this->getMethodParameterNamesFromClassReflection(
                                        $classReflection,
                                        $currentScope,
                                        $methodName,
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
                                $context,
                            );
                        }
                    } elseif ($node->class instanceof Expr) {
                        try {
                            $classType = $currentScope->getType($node->class);
                        } catch (Throwable) {
                            $classType = null;
                        }
                        if ($classType !== null) {
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
                    if ($receiverType !== null) {
                        $params = $this->getMethodParameterNamesFromType($provider, $currentScope, $receiverType, $methodName);
                    }
                }

                if (count($params) === 0) {
                    return;
                }

                $hints = $this->buildArgumentHints($params, $arguments, $rangeStart, $rangeEnd);
                if (count($hints) === 0) {
                    return;
                }

                $payload[] = [
                    'callStartOffset' => $callStartOffset,
                    'hints' => $hints,
                ];
            }
        );

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
        return $this->collectCallArgumentPayloadFromScope(
            $filePath,
            $text,
            $rangeStart,
            $rangeEnd,
            $reflectionState,
        );
    }

    /**
     * @param array{namespace: string, useClasses: array<string, string>} $context
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
     * @param array<mixed> $params
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
        if (in_array('definition', $capabilities, true) && $filePath !== '' && $text !== '') {
            $result['definitions'] = $this->collectDefinitionPayload($filePath, $text, $cursorOffset);
        }

        return [
            'protocolVersion' => self::PROTOCOL_VERSION,
            'id' => $id,
            'ok' => true,
            'result' => $result,
        ];
    }

    /**
     * @return worker_response
     */
    private function handleRequest(mixed $payload): array
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
