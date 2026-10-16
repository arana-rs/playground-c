int main(void) { 
    struct Pair { int first; int second; };
    struct Arrays { int first[1]; int second[1]; };
    union Overlay { int first; int second; };
    struct Pair pair = { 1, 2 };
    struct Arrays arrays = { { 1 }, { 2 } };
    union Overlay overlay = { .first = 3 };
    return &pair.first < &pair.second && &pair.second > &pair.first &&
      &pair.first <= &pair.first && &pair.second >= &pair.first &&
      &arrays.first < &arrays.second &&
      !(&overlay.first < &overlay.second) && !(&overlay.first > &overlay.second) &&
      &overlay.first <= &overlay.second && &overlay.first >= &overlay.second;
   }