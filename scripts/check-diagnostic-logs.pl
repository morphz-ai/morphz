#!/usr/bin/env perl
use strict;
use warnings;
use utf8;
use File::Find;
use FindBin qw($Bin);
use File::Spec;

my $repo_root = File::Spec->rel2abs(File::Spec->catdir($Bin, '..'));
my $source_root = File::Spec->catdir($repo_root, 'morphz', 'src');
my @files;
find(
    sub {
        return unless -f $_ && /\.rs\z/;
        push @files, $File::Find::name;
    },
    $source_root,
);

my @errors;
my $total = 0;
for my $path (sort @files) {
    open my $handle, '<:encoding(UTF-8)', $path
        or die "cannot read $path: $!\n";
    local $/;
    my $source = <$handle>;
    close $handle;

    pos($source) = 0;
    while ($source =~ /tracing::(?:trace|debug|info|warn|error)!\(/g) {
        my $start = $-[0];
        my $cursor = $+[0];
        my $depth = 1;
        my $quote;
        my $escape = 0;
        while ($cursor < length($source) && $depth > 0) {
            my $char = substr($source, $cursor, 1);
            if (defined $quote) {
                if ($escape) {
                    $escape = 0;
                } elsif ($char eq '\\') {
                    $escape = 1;
                } elsif ($char eq $quote) {
                    undef $quote;
                }
            } else {
                if ($char eq '"' || $char eq "'") {
                    $quote = $char;
                } elsif ($char eq '(') {
                    ++$depth;
                } elsif ($char eq ')') {
                    --$depth;
                }
            }
            ++$cursor;
        }

        ++$total;
        my $block = substr($source, $start, $cursor - $start);
        my $line = 1 + (substr($source, 0, $start) =~ tr/\n//);
        if ($block =~ /\p{Han}/) {
            push @errors, "$path:$line: diagnostic message contains Han characters";
        }
        if ($block !~ /\bevent_code\s*=\s*"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/) {
            push @errors,
                "$path:$line: tracing call requires a stable namespaced event_code";
        }
        pos($source) = $cursor;
    }
}

if (@errors) {
    print STDERR "Diagnostic log policy violations:\n", join("\n", @errors), "\n";
    exit 1;
}

print "Validated $total diagnostic tracing calls.\n";
