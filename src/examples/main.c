#include <stdio.h>

int main(void) {
    /* Step through to see intermediate cursor positions; this example does not animate. */
    puts("This message will be cleared by CSI 2J, then the cursor will return home.");
    fflush(stdout);
    printf("\033[2J\033[H");

    puts("Carriage return replaces an equal-length line:");
    printf("OLD TEXT\rNEW TEXT\n");

    puts("Backspace moves left, then C replaces X:");
    printf("ABX\bC\n");

    puts("Carriage return + CSI 2K clears the current line:");
    printf("Discarded text that will disappear");
    fflush(stdout);
    printf("\r\033[2K");
    puts("Clean replacement after CSI 2K.");

    return 0;
}
