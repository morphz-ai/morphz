#!/usr/bin/env perl
use strict;
use warnings;
use utf8;
use FindBin qw($Bin);
use File::Spec;

binmode STDERR, ':encoding(UTF-8)';
binmode STDOUT, ':encoding(UTF-8)';

my $repo_root = File::Spec->rel2abs(File::Spec->catdir($Bin, '..'));
my @relative_paths = (
    glob(File::Spec->catfile($repo_root, 'yao', 'src', '*.rs')),
    map { File::Spec->catfile($repo_root, 'morphz', 'src', $_) } (
        'approval.rs',
        'approval_authority.rs',
        'activation_admission.rs',
        'artifact.rs',
        'config.rs',
        'context_tools.rs',
        'edge_node.rs',
        'event.rs',
        'execution.rs',
        'execution_target.rs',
        'harness.rs',
        'harness_package.rs',
        'harness_tool.rs',
        'model_input.rs',
        'memory/mod.rs',
        'objective.rs',
        'orchestrator/context.rs',
        'orchestrator/orchestrator.rs',
        'permission.rs',
        'plan_execution.rs',
        'provider.rs',
        'provider/auth.rs',
        'provider/routing.rs',
        'recovery/reconciler.rs',
        'runtime.rs',
        'sandbox.rs',
        'scheduler/domain.rs',
        'scheduler/kernel.rs',
        'sdk.rs',
        'secret_store.rs',
        'sexpr.rs',
        'sexpr_eval.rs',
        'timer.rs',
        'tool.rs',
        'web.rs',
    ),
);

my @errors;
for my $path (@relative_paths) {
    open my $handle, '<:encoding(UTF-8)', $path
        or die "cannot read $path: $!\n";
    local $/;
    my $source = <$handle>;
    close $handle;

    # Language-specific fixtures belong in tests. The protocol and Runtime
    # implementation before the conventional test module remains canonical
    # English so the same diagnostics can cross API, persistence, and model
    # boundaries without locale-dependent control flow.
    $source =~ s/\n#\[cfg\(test\)\]\s*\nmod tests\s*\{.*\z//s;
    my @lines = split /\n/, $source, -1;
    for my $index (0 .. $#lines) {
        next unless $lines[$index] =~ /\p{Han}/;
        my $context_start = $index > 2 ? $index - 2 : 0;
        my $context = join "\n", @lines[$context_start .. $index];
        next if $context =~ /Legacy persisted output compatibility/;
        my $display = File::Spec->abs2rel($path, $repo_root);
        push @errors, "$display:" . ($index + 1) . ":$lines[$index]";
    }
}

# These files also contain localized UI copy, model prompts, and language
# fixtures, so they cannot be subject to a blanket Han-character ban. They do,
# however, sit on the model-visible tool-output path. Reject the historical
# Chinese diagnostic prefixes there unless a compatibility reader is clearly
# annotated; new producers must use the canonical English prefixes.
my @model_visible_paths = map { File::Spec->catfile($repo_root, 'morphz', 'src', $_) } (
    'event.rs',
    'execution_target.rs',
    'orchestrator/context.rs',
    'orchestrator/orchestrator.rs',
    'tool.rs',
);
my $legacy_prefix = qr/(?:执行失败|执行拒绝|执行超时|系统报错)[：:]/;
for my $path (@model_visible_paths) {
    open my $handle, '<:encoding(UTF-8)', $path
        or die "cannot read $path: $!\n";
    local $/;
    my $source = <$handle>;
    close $handle;
    $source =~ s/\n#\[cfg\(test\)\]\s*\nmod tests\s*\{.*\z//s;
    my @lines = split /\n/, $source, -1;
    for my $index (0 .. $#lines) {
        next unless $lines[$index] =~ $legacy_prefix;
        my $context_start = $index > 3 ? $index - 3 : 0;
        my $context = join "\n", @lines[$context_start .. $index];
        next if $context =~ /Legacy persisted output compatibility/;
        my $display = File::Spec->abs2rel($path, $repo_root);
        push @errors, "$display:" . ($index + 1) . ":$lines[$index]";
    }
}

if (@errors) {
    print STDERR "Core protocol and Runtime surfaces must use canonical English.\n";
    print STDERR join("\n", @errors), "\n";
    exit 1;
}

print "Validated canonical English for Yao and core execution protocol surfaces.\n";
