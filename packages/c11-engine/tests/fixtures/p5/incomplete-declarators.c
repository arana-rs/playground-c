struct Opaque;

typedef struct Opaque *OpaquePointer;
typedef OpaquePointer OpaquePointerArray[2];
typedef struct Opaque OpaqueReturningFunction(void);

OpaqueReturningFunction *opaque_function_pointer;
struct Opaque opaque_returning_function(void);
int opaque_value_parameter(struct Opaque value);

int opaque_pointer_parameter(struct Opaque *value) {
  return value != 0;
}

int main(void) {
  typedef OpaquePointer LocalOpaquePointer;
  LocalOpaquePointer pointer = 0;
  OpaquePointerArray pointers = { 0, 0 };
  return pointer == 0 && pointers[0] == 0 ? 1 : 0;
}
