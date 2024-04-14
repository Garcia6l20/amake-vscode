export function arrayCompare(lhs: any[], rhs: any[]) {
    return (lhs.length === rhs.length) && (lhs.every((item, ii) => item === rhs[ii]));
}
