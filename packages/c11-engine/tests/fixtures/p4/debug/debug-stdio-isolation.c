#include <stdio.h>

static int *destination(void) {
    static int target;
    return &target;
}

int main(void) {
    int value = 17;
    FILE *missing = fopen("absent", "r");
    int scanned = scanf("%d", &value);
    int side_effect_scan = scanf("%d", destination());
    int stream_scanned = fscanf(stdin, "%d", &value);
    int file_scanned = fscanf(missing, "%d", &value);
    int first = getchar();
    int second = getc(stdin);
    int third = fgetc(stdin);
    char text[8] = "keep";
    char *line = fgets(text, sizeof text, stdin);
    size_t read_count = fread(text, 1, 2, stdin);
    int file_line = fgets(text, sizeof text, missing) == NULL;
    size_t file_count = fread(text, 1, 1, missing);
    int printed = printf("discard");
    int fprintfed = fprintf(stdout, "%d", 7);
    int char_written = putchar('x');
    int stream_char = fputc('y', stdout);
    int string_written = fputs("z", stdout);
    size_t written_count = fwrite("q", 1, 1, stdout);
    int file_written = fprintf(missing, "%d", 8);
    char formatted[8];
    int format_count = sprintf(formatted, "%d", 42);
    char bounded[8];
    int bounded_count = snprintf(bounded, sizeof bounded, "%s", formatted);
    int parsed = 0;
    int parsed_count = sscanf(bounded, "%d", &parsed);
    if (scanned == EOF && side_effect_scan == EOF && stream_scanned == EOF && file_scanned == EOF &&
        first == EOF && second == EOF && third == EOF && line == NULL &&
        read_count == 0 && missing == NULL && file_line && file_count == 0 &&
        printed == 0 && fprintfed == 0 && char_written == 0 && stream_char == 0 &&
        string_written == 0 && written_count == 0 && file_written == 0 &&
        format_count == 2 && bounded_count == 2 && parsed_count == 1 && parsed == 42 &&
        bounded[0] == '4' && bounded[1] == '2' && value == 17 &&
        text[0] == 'k' && text[3] == 'p') {
        int io_ok = 1;
    } else {
        int io_failed = 1;
    }
    return 0;
}
